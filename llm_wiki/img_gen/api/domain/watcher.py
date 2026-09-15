"""Filesystem watcher for local mode.

Watches the workspace for file changes and updates the SQLite index.
Uses watchfiles for efficient cross-platform filesystem monitoring.

Key design rules:
- App-initiated writes register in _recently_written to prevent re-indexing loops
- Hidden dirs (.llmwiki, .git, node_modules, etc.) are ignored
- File identity is by path — rename = delete old + create new
"""

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from pathlib import Path

import aiosqlite

logger = logging.getLogger(__name__)

IGNORE_DIRS = frozenset({
    ".llmwiki", ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".idea", ".vscode", ".DS_Store",
})

TEXT_EXTENSIONS = frozenset({
    "md", "txt", "csv", "html", "svg", "json", "xml", "yaml", "yml",
    "toml", "ini", "cfg", "rst", "tex", "latex",
})

COOLDOWN_SECONDS = 2.0

_ignore_patterns: list[str] | None = None


def _load_ignore_patterns(workspace: Path) -> list[str]:
    """Load ignore patterns from .llmwikiignore, falling back to .gitignore."""
    global _ignore_patterns
    if _ignore_patterns is not None:
        return _ignore_patterns

    patterns = []
    for ignore_file in (".llmwikiignore", ".gitignore"):
        p = workspace / ignore_file
        if p.is_file():
            for line in p.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    patterns.append(line)
            break  # Use first found, don't merge
    _ignore_patterns = patterns
    return patterns


def _matches_ignore_pattern(relative: str, patterns: list[str]) -> bool:
    """Simple gitignore-style matching (directory and glob patterns)."""
    from fnmatch import fnmatch
    for pattern in patterns:
        pattern = pattern.rstrip("/")
        if fnmatch(relative, pattern):
            return True
        if fnmatch(relative, f"**/{pattern}"):
            return True
        # Check if any path component matches a directory pattern
        for part in relative.split("/"):
            if fnmatch(part, pattern):
                return True
    return False

# Paths written by the app — skip re-indexing for these
_recently_written: dict[str, float] = {}


def mark_written(path: str) -> None:
    """Mark a path as recently written by the app. Watcher will skip it."""
    _recently_written[str(Path(path).resolve())] = time.monotonic()


def _is_recently_written(path: str) -> bool:
    resolved = str(Path(path).resolve())
    ts = _recently_written.get(resolved)
    if ts and (time.monotonic() - ts) < COOLDOWN_SECONDS:
        return True
    _recently_written.pop(resolved, None)
    return False


def _should_ignore(path: Path, workspace: Path) -> bool:
    """Check if a path should be ignored based on directory rules + ignore files."""
    try:
        relative = path.relative_to(workspace)
    except ValueError:
        return True

    relative_str = str(relative)
    parts = relative.parts

    # Skip wiki assets (images extracted from PDFs) — they are static
    if relative_str.startswith("wiki/assets/"):
        return True

    # Built-in ignores
    for part in parts:
        if part in IGNORE_DIRS or part.startswith("."):
            return True

    # User-configured ignore patterns
    patterns = _load_ignore_patterns(workspace)
    if patterns and _matches_ignore_pattern(relative_str, patterns):
        return True

    return False


def _get_source_kind(relative_path: str) -> str:
    if relative_path.startswith("wiki/assets/"):
        return "asset"
    if relative_path.startswith("wiki/"):
        return "wiki"
    return "source"


# ── Access scope resolution ──────────────────────────────────────────────────

# Cache of directory_meta rows: {path: {scope, department_slug, owner_email, subdirectory_attribute}}
_directory_meta_cache: dict[str, dict] | None = None


async def _load_directory_meta(db: aiosqlite.Connection) -> dict[str, dict]:
    """Load directory_meta table into cache."""
    global _directory_meta_cache
    if _directory_meta_cache is not None:
        return _directory_meta_cache

    _directory_meta_cache = {}
    try:
        cursor = await db.execute(
            "SELECT dm.path, dm.scope, dm.owner_email, dm.subdirectory_attribute, "
            "dm.subdirectory_label, d.slug as department_slug "
            "FROM directory_meta dm "
            "LEFT JOIN departments d ON dm.department_id = d.id"
        )
        rows = await cursor.fetchall()
        for row in rows:
            path, scope, owner_email, sub_attr, sub_label, dept_slug = row
            _directory_meta_cache[path] = {
                "scope": scope,
                "department_slug": dept_slug,
                "owner_email": owner_email,
                "subdirectory_attribute": sub_attr,
                "subdirectory_label": sub_label,
            }
    except Exception:
        # Table may not exist yet (pre-enterprise schema)
        _directory_meta_cache = {}
    return _directory_meta_cache


def invalidate_directory_meta_cache() -> None:
    """Call after SCHEMA.md re-init to refresh the cache."""
    global _directory_meta_cache
    _directory_meta_cache = None


async def _resolve_access_scope(db: aiosqlite.Connection, relative_path: str) -> str:
    """Derive access_scope from file path using directory_meta."""
    meta_cache = await _load_directory_meta(db)
    if not meta_cache:
        return "global"

    parts = relative_path.split("/")

    # Root-level files
    if len(parts) == 1:
        return "global"

    # Wiki files: mirror the corresponding raw path
    if parts[0] == "wiki":
        raw_equivalent = "raw/" + "/".join(parts[1:])
        return await _resolve_access_scope(db, raw_equivalent)

    # Search from most specific path up to root
    for depth in range(len(parts) - 1, 0, -1):
        check_path = "/" + "/".join(parts[:depth])
        if check_path in meta_cache:
            meta = meta_cache[check_path]
            scope = meta["scope"]
            if scope == "personal" and meta.get("owner_email"):
                return f"personal:{meta['owner_email']}"
            if scope == "department" and meta.get("department_slug"):
                return f"department:{meta['department_slug']}"
            if scope == "restricted":
                return f"restricted:{check_path}"
            return "global"

    return "global"


async def _extract_directory_metadata(db: aiosqlite.Connection, relative_path: str) -> str | None:
    """Extract subdirectory attribute as metadata JSON if applicable.

    E.g., file at raw/销售部/LC-Waikiki/xxx.pdf with subdirectory_attribute='customer'
    → returns '{"customer": "LC-Waikiki"}'
    """
    meta_cache = await _load_directory_meta(db)
    if not meta_cache:
        return None

    parts = relative_path.split("/")
    if len(parts) < 3:
        return None

    # Find the directory_meta entry for the parent that has subdirectory_attribute
    for depth in range(len(parts) - 1, 0, -1):
        check_path = "/" + "/".join(parts[:depth])
        if check_path in meta_cache:
            meta = meta_cache[check_path]
            sub_attr = meta.get("subdirectory_attribute")
            if sub_attr and depth < len(parts) - 1:
                # The next path component after this directory is the attribute value
                attr_value = parts[depth]
                return json.dumps({sub_attr: attr_value}, ensure_ascii=False)
            break

    return None


async def _index_file(db: aiosqlite.Connection, workspace: Path, file_path: Path) -> None:
    """Index or re-index a single file."""
    relative = str(file_path.relative_to(workspace))
    filename = file_path.name
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    parts = relative.split("/")
    if len(parts) > 1:
        dir_path = "/" + "/".join(parts[:-1]) + "/"
    else:
        dir_path = "/"

    source_kind = _get_source_kind(relative)
    stat = file_path.stat()

    # Derive title
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    title = stem.replace("-", " ").replace("_", " ").strip().title()

    # Read content for text files
    content = None
    if ext in TEXT_EXTENSIONS:
        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            pass

    content_hash = None
    if stat.st_size < 100_000_000:
        try:
            content_hash = hashlib.sha256(file_path.read_bytes()).hexdigest()
        except Exception:
            pass

    # Check if document already exists at this path
    cursor = await db.execute(
        "SELECT id, content_hash FROM documents WHERE relative_path = ?",
        (relative,),
    )
    existing = await cursor.fetchone()

    # Resolve enterprise access scope and directory metadata
    access_scope = await _resolve_access_scope(db, relative)
    dir_metadata = await _extract_directory_metadata(db, relative)

    if existing:
        doc_id, old_hash = existing
        if old_hash == content_hash:
            return  # No change
        # Update existing
        await db.execute(
            "UPDATE documents SET content = ?, file_size = ?, content_hash = ?, "
            "mtime_ns = ?, last_indexed_at = datetime('now'), "
            "updated_at = datetime('now'), version = version + 1, "
            "access_scope = ?, metadata = COALESCE(?, metadata) "
            "WHERE id = ?",
            (content, stat.st_size, content_hash, int(stat.st_mtime_ns),
             access_scope, dir_metadata, doc_id),
        )
        await db.commit()
        logger.info("Re-indexed (modified): %s [%s]", relative, access_scope)
        # Re-process non-text files
        if ext not in TEXT_EXTENSIONS and ext:
            from domain.local_processor import process_document as _process
            import asyncio
            asyncio.create_task(_process(db, doc_id, workspace))
        return
    else:
        # Create new
        doc_id = str(uuid.uuid4())
        cursor = await db.execute(
            "SELECT COALESCE(MAX(document_number), 0) + 1 FROM documents",
        )
        row = await cursor.fetchone()
        doc_number = row[0]

        status = "ready" if content is not None else "pending"
        await db.execute(
            "INSERT INTO documents (id, user_id, filename, title, path, relative_path, "
            "source_kind, file_type, file_size, status, content, tags, version, "
            "content_hash, mtime_ns, last_indexed_at, document_number, "
            "access_scope, metadata) "
            "VALUES (?, (SELECT user_id FROM workspace LIMIT 1), ?, ?, ?, ?, ?, ?, ?, "
            "?, ?, '[]', 0, ?, ?, datetime('now'), ?, ?, ?)",
            (doc_id, filename, title, dir_path, relative, source_kind,
             ext or "bin", stat.st_size, status, content, content_hash,
             int(stat.st_mtime_ns), doc_number, access_scope, dir_metadata),
        )
        logger.info("Indexed (new): %s [%s]", relative, access_scope)
        # Process non-text files (PDFs, spreadsheets, images, HTML)
        if status == "pending":
            from domain.local_processor import process_document as _process
            import asyncio
            asyncio.create_task(_process(db, doc_id, workspace))

    await db.commit()


async def _remove_file(db: aiosqlite.Connection, workspace: Path, file_path: Path) -> None:
    """Remove a file from the index."""
    try:
        relative = str(file_path.relative_to(workspace))
    except ValueError:
        return

    cursor = await db.execute(
        "DELETE FROM documents WHERE relative_path = ?", (relative,),
    )
    if cursor.rowcount > 0:
        await db.commit()
        logger.info("Removed from index: %s", relative)


async def watch_workspace(db: aiosqlite.Connection, workspace: Path) -> None:
    """Watch the workspace for file changes and update the SQLite index.

    Runs indefinitely as an async task. Cancel to stop.
    """
    from watchfiles import awatch, Change

    logger.info("File watcher started: %s", workspace)

    async for changes in awatch(
        str(workspace),
        watch_filter=lambda change, path: not _should_ignore(Path(path), workspace),
        debounce=500,
        step=200,
    ):
        for change_type, path_str in changes:
            path = Path(path_str)

            if _should_ignore(path, workspace):
                continue

            if _is_recently_written(path_str):
                continue

            try:
                if change_type == Change.added or change_type == Change.modified:
                    if path.is_file():
                        await _index_file(db, workspace, path)
                elif change_type == Change.deleted:
                    await _remove_file(db, workspace, path)
            except Exception as e:
                logger.warning("Watcher error for %s: %s", path_str, e)

        # Clean up expired entries from _recently_written
        now = time.monotonic()
        expired = [k for k, v in _recently_written.items() if now - v > COOLDOWN_SECONDS * 2]
        for k in expired:
            _recently_written.pop(k, None)
