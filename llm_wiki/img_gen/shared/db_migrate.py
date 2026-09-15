#!/usr/bin/env python3
"""Database migration for LLM Wiki.

Checks the existing SQLite database against the expected schema and applies
incremental migrations. Safe to re-run (idempotent).

Exit codes:
  0 — success (migrations applied or already up to date)
  1 — fatal error (cannot proceed)
  2 — user action required (e.g., SCHEMA.md missing for enterprise features)
"""

import sqlite3
import sys
from pathlib import Path

# Current schema version — bump this when adding new migrations
SCHEMA_VERSION = 2

SCHEMA_SQL = Path(__file__).resolve().parent / "sqlite_schema.sql"


def get_db_version(db: sqlite3.Connection) -> int:
    """Read schema version from the database. Returns 0 for legacy databases."""
    try:
        row = db.execute("SELECT version FROM _schema_meta LIMIT 1").fetchone()
        return row[0] if row else 0
    except sqlite3.OperationalError:
        return 0


def set_db_version(db: sqlite3.Connection, version: int) -> None:
    db.execute(
        "CREATE TABLE IF NOT EXISTS _schema_meta (version INTEGER NOT NULL)"
    )
    db.execute("DELETE FROM _schema_meta")
    db.execute("INSERT INTO _schema_meta (version) VALUES (?)", (version,))
    db.commit()


def table_exists(db: sqlite3.Connection, name: str) -> bool:
    row = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def column_exists(db: sqlite3.Connection, table: str, column: str) -> bool:
    try:
        cols = db.execute(f"PRAGMA table_info({table})").fetchall()
        return any(c[1] == column for c in cols)
    except sqlite3.OperationalError:
        return False


# ── Migration definitions ─────────────────────────────────────────────────

def migrate_v1_to_v2(db: sqlite3.Connection, workspace: Path) -> list[str]:
    """Add enterprise RBAC tables and access_scope column."""
    actions = []

    # 1. Add access_scope column to documents if missing
    if not column_exists(db, "documents", "access_scope"):
        db.execute("ALTER TABLE documents ADD COLUMN access_scope TEXT DEFAULT 'global'")
        actions.append("Added 'access_scope' column to documents table")

    # 2. Create enterprise RBAC tables if missing
    enterprise_tables = [
        ("organizations", """
            CREATE TABLE IF NOT EXISTS organizations (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                language TEXT DEFAULT 'zh',
                created_at TEXT DEFAULT (datetime('now'))
            )"""),
        ("org_members", """
            CREATE TABLE IF NOT EXISTS org_members (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                email TEXT NOT NULL,
                display_name TEXT,
                role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(org_id, email)
            )"""),
        ("departments", """
            CREATE TABLE IF NOT EXISTS departments (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                slug TEXT NOT NULL,
                head_email TEXT,
                subdirectory_attribute TEXT,
                subdirectory_label TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(org_id, slug)
            )"""),
        ("department_members", """
            CREATE TABLE IF NOT EXISTS department_members (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                email TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'editor')),
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(department_id, email)
            )"""),
        ("workgroups", """
            CREATE TABLE IF NOT EXISTS workgroups (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                slug TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(org_id, slug)
            )"""),
        ("workgroup_members", """
            CREATE TABLE IF NOT EXISTS workgroup_members (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                workgroup_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
                email TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(workgroup_id, email)
            )"""),
        ("directory_meta", """
            CREATE TABLE IF NOT EXISTS directory_meta (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                path TEXT NOT NULL UNIQUE,
                scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'department', 'personal', 'restricted')),
                department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
                owner_email TEXT,
                description TEXT,
                subdirectory_attribute TEXT,
                subdirectory_label TEXT,
                extra_config TEXT DEFAULT '{}',
                created_at TEXT DEFAULT (datetime('now'))
            )"""),
        ("directory_permissions", """
            CREATE TABLE IF NOT EXISTS directory_permissions (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                directory_path TEXT NOT NULL,
                grantee_email TEXT,
                grantee_department_slug TEXT,
                grantee_workgroup_slug TEXT,
                role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
                exclude_paths TEXT DEFAULT '[]',
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(directory_path, grantee_email),
                UNIQUE(directory_path, grantee_department_slug),
                UNIQUE(directory_path, grantee_workgroup_slug)
            )"""),
    ]

    for tbl_name, create_sql in enterprise_tables:
        if not table_exists(db, tbl_name):
            db.execute(create_sql)
            actions.append(f"Created table '{tbl_name}'")

    # 3. Create indexes for enterprise tables
    indexes = [
        "CREATE INDEX IF NOT EXISTS idx_org_members_email ON org_members(email)",
        "CREATE INDEX IF NOT EXISTS idx_dept_members_email ON department_members(email)",
        "CREATE INDEX IF NOT EXISTS idx_directory_meta_path ON directory_meta(path)",
        "CREATE INDEX IF NOT EXISTS idx_directory_meta_scope ON directory_meta(scope)",
        "CREATE INDEX IF NOT EXISTS idx_directory_permissions_path ON directory_permissions(directory_path)",
    ]
    for idx_sql in indexes:
        db.execute(idx_sql)

    db.commit()
    return actions


# ── Migration registry ────────────────────────────────────────────────────

MIGRATIONS = {
    # (from_version, to_version): migration_function
    (1, 2): migrate_v1_to_v2,
}


# ── Main ──────────────────────────────────────────────────────────────────

def run_migrations(db_path: str, workspace: Path) -> int:
    """Run all pending migrations. Returns exit code."""
    if not Path(db_path).exists():
        print(f"[migrate] No database at {db_path} — will be created on first start.")
        return 0

    db = sqlite3.connect(db_path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")

    current = get_db_version(db)

    # Legacy database (no version tracking) — detect by checking core table
    if current == 0 and table_exists(db, "documents"):
        current = 1
        print(f"[migrate] Legacy database detected (no version tracking). Treating as v1.")

    if current >= SCHEMA_VERSION:
        print(f"[migrate] Database is up to date (v{current}).")
        set_db_version(db, SCHEMA_VERSION)
        db.close()
        return 0

    print(f"[migrate] Database version: v{current} → v{SCHEMA_VERSION}")
    print(f"[migrate] Applying migrations...")

    version = current
    while version < SCHEMA_VERSION:
        next_version = version + 1
        key = (version, next_version)
        if key not in MIGRATIONS:
            print(f"[migrate] ERROR: No migration path from v{version} to v{next_version}")
            db.close()
            return 1

        print(f"[migrate]   v{version} → v{next_version}...")
        try:
            actions = MIGRATIONS[key](db, workspace)
            for action in actions:
                print(f"[migrate]     ✓ {action}")
            version = next_version
        except Exception as e:
            print(f"[migrate]   ERROR: {e}")
            db.close()
            return 1

    set_db_version(db, SCHEMA_VERSION)
    print(f"[migrate] Migration complete. Database is now v{SCHEMA_VERSION}.")

    # Check for SCHEMA.md (enterprise features)
    schema_path = workspace / "SCHEMA.md"
    if not schema_path.exists():
        print()
        print("=" * 70)
        print("  NOTICE: SCHEMA.md not found in workspace")
        print("=" * 70)
        print()
        print("  Enterprise features (departments, permissions, customer directories)")
        print("  require a SCHEMA.md configuration file in your workspace root.")
        print()
        print("  To set up enterprise mode:")
        print(f"    1. Copy the sample:  cp /app/SCHEMA.md.sample {workspace}/SCHEMA.md")
        print(f"    2. Edit it to match your organization structure")
        print(f"    3. Restart the container to apply")
        print()
        print("  Without SCHEMA.md, the system runs in personal (single-user) mode.")
        print("=" * 70)
        print()

    db.close()
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <workspace_path>")
        sys.exit(1)

    workspace = Path(sys.argv[1]).resolve()
    db_path = str(workspace / ".llmwiki" / "index.db")
    sys.exit(run_migrations(db_path, workspace))
