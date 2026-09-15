"""SCHEMA.md parser and workspace initializer.

Reads SCHEMA.md from the workspace root, parses YAML frontmatter,
and initializes the enterprise data model (organizations, departments,
members, directory metadata, permissions).

Idempotent: safe to re-run on every startup. Only inserts/updates,
never deletes existing data.
"""

import json
import logging
import re
import uuid
from pathlib import Path

import aiosqlite
import yaml

logger = logging.getLogger(__name__)

SCHEMA_FILENAME = "SCHEMA.md"


# ── Frontmatter parsing ─────────────────────────────────────────────────────

def parse_schema_file(workspace: Path) -> tuple[dict, str] | None:
    """Parse SCHEMA.md from workspace root. Returns (config, body) or None."""
    schema_path = workspace / SCHEMA_FILENAME
    if not schema_path.is_file():
        logger.info("No %s found in workspace — skipping enterprise init", SCHEMA_FILENAME)
        return None

    text = schema_path.read_text(encoding="utf-8")
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", text, re.DOTALL)
    if not match:
        logger.warning("%s has no YAML frontmatter — skipping", SCHEMA_FILENAME)
        return None

    try:
        config = yaml.safe_load(match.group(1))
    except yaml.YAMLError as e:
        logger.error("Failed to parse %s frontmatter: %s", SCHEMA_FILENAME, e)
        return None

    if not isinstance(config, dict):
        logger.error("%s frontmatter is not a dict", SCHEMA_FILENAME)
        return None

    body = match.group(2).strip()
    return config, body


# ── ID generation ────────────────────────────────────────────────────────────

def _make_id() -> str:
    return uuid.uuid4().hex


def _user_id_from_email(email: str) -> str:
    """Deterministic user_id from email for local mode."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"mailto:{email}"))


# ── Main initializer ────────────────────────────────────────────────────────

async def init_from_schema(db: aiosqlite.Connection, workspace: Path) -> dict | None:
    """Parse SCHEMA.md and initialize enterprise tables. Returns parsed config or None."""
    result = parse_schema_file(workspace)
    if result is None:
        return None

    config, body = result
    org_cfg = config.get("organization", {})
    if not org_cfg.get("name"):
        logger.warning("SCHEMA.md: organization.name is required")
        return None

    org_id = await _ensure_organization(db, org_cfg)
    await _sync_roles(db, org_id, config.get("roles", {}))
    await _sync_members(db, org_id, config.get("roles", {}))
    dept_map = await _sync_departments(db, org_id, config.get("departments", {}))
    await _sync_workgroups(db, org_id, config.get("workgroups", {}))
    await _sync_directories(db, workspace, config.get("directories", {}), dept_map)
    await _sync_personal_dirs(db, workspace, org_id, config.get("directories", {}))

    await db.commit()
    logger.info("Enterprise init complete: org=%s", org_cfg["name"])

    # Return full config + body for guide integration
    config["_body"] = body
    config["_org_id"] = org_id
    return config


# ── Organization ─────────────────────────────────────────────────────────────

async def _ensure_organization(db: aiosqlite.Connection, org_cfg: dict) -> str:
    name = org_cfg["name"]
    slug = org_cfg.get("slug", name.lower().replace(" ", "-"))
    lang = org_cfg.get("language", "zh")

    cursor = await db.execute("SELECT id FROM organizations WHERE slug = ?", (slug,))
    row = await cursor.fetchone()
    if row:
        await db.execute(
            "UPDATE organizations SET name = ?, language = ? WHERE id = ?",
            (name, lang, row[0]),
        )
        return row[0]

    org_id = _make_id()
    await db.execute(
        "INSERT INTO organizations (id, name, slug, language) VALUES (?, ?, ?, ?)",
        (org_id, name, slug, lang),
    )
    return org_id


# ── Admin / Member roles ────────────────────────────────────────────────────

async def _sync_roles(db: aiosqlite.Connection, org_id: str, roles: dict) -> None:
    """Sync admin users."""
    admins = roles.get("admin", [])
    for email in admins:
        user_id = _user_id_from_email(email)
        await db.execute(
            "INSERT INTO org_members (id, org_id, user_id, email, role) "
            "VALUES (?, ?, ?, ?, 'admin') "
            "ON CONFLICT(org_id, email) DO UPDATE SET role = 'admin', user_id = ?",
            (_make_id(), org_id, user_id, email, user_id),
        )


async def _sync_members(db: aiosqlite.Connection, org_id: str, roles: dict) -> None:
    """Sync regular members (won't downgrade admins)."""
    members = roles.get("members", [])
    for email in members:
        user_id = _user_id_from_email(email)
        # Only insert if not already present (don't overwrite admin role)
        await db.execute(
            "INSERT INTO org_members (id, org_id, user_id, email, role) "
            "VALUES (?, ?, ?, ?, 'member') "
            "ON CONFLICT(org_id, email) DO UPDATE SET user_id = ?",
            (_make_id(), org_id, user_id, email, user_id),
        )


# ── Departments ──────────────────────────────────────────────────────────────

async def _sync_departments(
    db: aiosqlite.Connection, org_id: str, departments: dict
) -> dict[str, str]:
    """Sync departments. Returns {dept_name: dept_id} mapping."""
    dept_map: dict[str, str] = {}

    for dept_name, dept_cfg in departments.items():
        slug = dept_cfg.get("slug", dept_name.lower().replace(" ", "-"))
        head_email = dept_cfg.get("head")
        sub_attr = dept_cfg.get("subdirectory_attribute")
        sub_label = dept_cfg.get("subdirectory_label")

        cursor = await db.execute(
            "SELECT id FROM departments WHERE org_id = ? AND slug = ?",
            (org_id, slug),
        )
        row = await cursor.fetchone()
        if row:
            dept_id = row[0]
            await db.execute(
                "UPDATE departments SET name = ?, head_email = ?, "
                "subdirectory_attribute = ?, subdirectory_label = ? WHERE id = ?",
                (dept_name, head_email, sub_attr, sub_label, dept_id),
            )
        else:
            dept_id = _make_id()
            await db.execute(
                "INSERT INTO departments (id, org_id, name, slug, head_email, "
                "subdirectory_attribute, subdirectory_label) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (dept_id, org_id, dept_name, slug, head_email, sub_attr, sub_label),
            )

        dept_map[dept_name] = dept_id

        # Sync department members
        all_members = set(dept_cfg.get("members", []))
        editors = set(dept_cfg.get("editors", []))
        if head_email:
            all_members.add(head_email)
            editors.add(head_email)

        for email in all_members:
            user_id = _user_id_from_email(email)
            role = "editor" if email in editors else "member"
            await db.execute(
                "INSERT INTO department_members (id, department_id, user_id, email, role) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(department_id, email) DO UPDATE SET role = ?, user_id = ?",
                (_make_id(), dept_id, user_id, email, role, role, user_id),
            )

    return dept_map


# ── Workgroups ───────────────────────────────────────────────────────────────

async def _sync_workgroups(db: aiosqlite.Connection, org_id: str, workgroups: dict) -> None:
    for wg_name, wg_cfg in workgroups.items():
        slug = wg_cfg.get("slug", wg_name.lower().replace(" ", "-"))

        cursor = await db.execute(
            "SELECT id FROM workgroups WHERE org_id = ? AND slug = ?",
            (org_id, slug),
        )
        row = await cursor.fetchone()
        if row:
            wg_id = row[0]
        else:
            wg_id = _make_id()
            await db.execute(
                "INSERT INTO workgroups (id, org_id, name, slug) VALUES (?, ?, ?, ?)",
                (wg_id, org_id, wg_name, slug),
            )

        # Sync members
        for email in wg_cfg.get("members", []):
            await db.execute(
                "INSERT INTO workgroup_members (id, workgroup_id, email) "
                "VALUES (?, ?, ?) ON CONFLICT(workgroup_id, email) DO NOTHING",
                (_make_id(), wg_id, email),
            )

        # Sync grant_access → directory_permissions
        for grant in wg_cfg.get("grant_access", []):
            path = grant.get("path", "")
            role = grant.get("role", "viewer")
            exclude = json.dumps(grant.get("exclude", []))
            await db.execute(
                "INSERT INTO directory_permissions "
                "(id, directory_path, grantee_workgroup_slug, role, exclude_paths) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(directory_path, grantee_workgroup_slug) "
                "DO UPDATE SET role = ?, exclude_paths = ?",
                (_make_id(), path, slug, role, exclude, role, exclude),
            )


# ── Directories ──────────────────────────────────────────────────────────────

async def _sync_directories(
    db: aiosqlite.Connection,
    workspace: Path,
    directories: dict,
    dept_map: dict[str, str],
) -> None:
    """Sync directory_meta entries and create physical directories."""
    for dir_path, dir_cfg in directories.items():
        scope = dir_cfg.get("scope", "global")
        dept_name = dir_cfg.get("department")
        dept_id = dept_map.get(dept_name) if dept_name else None
        owner_email = dir_cfg.get("owner_email")
        description = dir_cfg.get("description", "")
        sub_attr = dir_cfg.get("subdirectory_attribute")
        sub_label = dir_cfg.get("subdirectory_label")
        extra = {}

        # Collect extra config
        if "allowed_users" in dir_cfg:
            extra["allowed_users"] = dir_cfg["allowed_users"]
        if "allowed_departments" in dir_cfg:
            extra["allowed_departments"] = dir_cfg["allowed_departments"]
        if "extra_viewers" in dir_cfg:
            extra["extra_viewers"] = dir_cfg["extra_viewers"]

        extra_json = json.dumps(extra) if extra else "{}"

        # If scope=personal and path is /raw/个人, handle differently
        if scope == "personal" and dir_cfg.get("auto_create"):
            # Personal dirs are handled by _sync_personal_dirs
            pass

        # Inherit subdirectory_attribute from department if not set on directory
        if not sub_attr and dept_id:
            cursor = await db.execute(
                "SELECT subdirectory_attribute, subdirectory_label FROM departments WHERE id = ?",
                (dept_id,),
            )
            dept_row = await cursor.fetchone()
            if dept_row:
                sub_attr = sub_attr or dept_row[0]
                sub_label = sub_label or dept_row[1]

        await db.execute(
            "INSERT INTO directory_meta "
            "(id, path, scope, department_id, owner_email, description, "
            "subdirectory_attribute, subdirectory_label, extra_config) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(path) DO UPDATE SET "
            "scope = ?, department_id = ?, owner_email = ?, description = ?, "
            "subdirectory_attribute = ?, subdirectory_label = ?, extra_config = ?",
            (
                _make_id(), dir_path, scope, dept_id, owner_email, description,
                sub_attr, sub_label, extra_json,
                scope, dept_id, owner_email, description,
                sub_attr, sub_label, extra_json,
            ),
        )

        # Create physical directory (convert /raw/xxx to workspace-relative)
        phys_path = workspace / dir_path.lstrip("/")
        phys_path.mkdir(parents=True, exist_ok=True)

        # Pre-create subdirectories if listed
        for subdir in dir_cfg.get("subdirectories", []):
            sub_phys = phys_path / subdir
            sub_phys.mkdir(parents=True, exist_ok=True)

        # Sync extra permission overrides (extra_viewers, etc.)
        for email in dir_cfg.get("extra_viewers", []):
            await db.execute(
                "INSERT INTO directory_permissions "
                "(id, directory_path, grantee_email, role) "
                "VALUES (?, ?, ?, 'viewer') "
                "ON CONFLICT(directory_path, grantee_email) DO NOTHING",
                (_make_id(), dir_path + "/", email),
            )

        # Sync allowed_departments for restricted dirs
        for dept_slug in dir_cfg.get("allowed_departments", []):
            await db.execute(
                "INSERT INTO directory_permissions "
                "(id, directory_path, grantee_department_slug, role) "
                "VALUES (?, ?, ?, 'viewer') "
                "ON CONFLICT(directory_path, grantee_department_slug) DO NOTHING",
                (_make_id(), dir_path + "/", dept_slug),
            )

        # Sync allowed_users for restricted dirs
        for email in dir_cfg.get("allowed_users", []):
            await db.execute(
                "INSERT INTO directory_permissions "
                "(id, directory_path, grantee_email, role) "
                "VALUES (?, ?, ?, 'editor') "
                "ON CONFLICT(directory_path, grantee_email) DO UPDATE SET role = 'editor'",
                (_make_id(), dir_path + "/", email),
            )


# ── Personal directories ────────────────────────────────────────────────────

async def _sync_personal_dirs(
    db: aiosqlite.Connection,
    workspace: Path,
    org_id: str,
    directories: dict,
) -> None:
    """Create /raw/个人/<user>/ directories for all members."""
    # Find the personal root directory config
    personal_root = None
    personal_cfg = None
    for dir_path, dir_cfg in directories.items():
        if dir_cfg.get("scope") == "personal" and dir_cfg.get("auto_create"):
            personal_root = dir_path
            personal_cfg = dir_cfg
            break

    if not personal_root:
        return

    naming = personal_cfg.get("naming", "email_prefix")

    # Get all org members
    cursor = await db.execute(
        "SELECT email, display_name FROM org_members WHERE org_id = ?",
        (org_id,),
    )
    members = await cursor.fetchall()

    for email, display_name in members:
        if naming == "display_name" and display_name:
            dirname = display_name
        else:
            dirname = email.split("@")[0]

        user_path = f"{personal_root}/{dirname}"
        phys = workspace / user_path.lstrip("/")
        phys.mkdir(parents=True, exist_ok=True)

        # Register directory_meta
        await db.execute(
            "INSERT INTO directory_meta "
            "(id, path, scope, owner_email, description) "
            "VALUES (?, ?, 'personal', ?, ?) "
            "ON CONFLICT(path) DO UPDATE SET owner_email = ?",
            (_make_id(), user_path, email, f"{email} 的个人空间", email),
        )

    # Register the personal root itself
    phys_root = workspace / personal_root.lstrip("/")
    phys_root.mkdir(parents=True, exist_ok=True)
    await db.execute(
        "INSERT INTO directory_meta (id, path, scope, description) "
        "VALUES (?, ?, 'personal', '员工个人知识空间') "
        "ON CONFLICT(path) DO NOTHING",
        (_make_id(), personal_root),
    )


# ── Utility: resolve access_scope for a file path ───────────────────────────

async def resolve_access_scope(db: aiosqlite.Connection, relative_path: str) -> str:
    """Derive access_scope from file path using directory_meta.

    Returns one of:
      'global'                  — root files or global directories
      'department:<slug>'       — department directory
      'personal:<email>'        — personal directory
      'restricted:<path>'       — restricted directory
    """
    parts = relative_path.split("/")

    # Root-level files (no subdirectory)
    if len(parts) == 1:
        return "global"

    # Wiki files: mirror the corresponding raw path's scope
    if parts[0] == "wiki":
        # /wiki/销售部/xxx → check /raw/销售部/
        raw_equivalent = "raw/" + "/".join(parts[1:])
        scope = await resolve_access_scope(db, raw_equivalent)
        return scope

    # Build candidate paths from most specific to least
    # e.g., raw/销售部/LC-Waikiki/file.pdf → try /raw/销售部/LC-Waikiki, /raw/销售部, /raw
    for depth in range(len(parts) - 1, 0, -1):
        check_path = "/" + "/".join(parts[:depth])
        cursor = await db.execute(
            "SELECT scope, department_id, owner_email FROM directory_meta WHERE path = ?",
            (check_path,),
        )
        row = await cursor.fetchone()
        if row:
            scope, dept_id, owner_email = row
            if scope == "personal" and owner_email:
                return f"personal:{owner_email}"
            if scope == "department" and dept_id:
                # Look up department slug
                cursor2 = await db.execute(
                    "SELECT slug FROM departments WHERE id = ?", (dept_id,)
                )
                dept_row = await cursor2.fetchone()
                if dept_row:
                    return f"department:{dept_row[0]}"
            if scope == "restricted":
                return f"restricted:{check_path}"
            return "global"

    return "global"
