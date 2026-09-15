"""SQLite + local filesystem implementation of VaultFS."""

import json
import logging
import os
import uuid
from pathlib import Path

import aiosqlite

from .base import VaultFS

logger = logging.getLogger(__name__)

_SCHEMA_PATH = Path(__file__).parent.parent.parent / "shared" / "sqlite_schema.sql"

_db: aiosqlite.Connection | None = None
_workspace_root: Path | None = None


def _rows_to_dicts(cursor: aiosqlite.Cursor, rows: list[tuple]) -> list[dict]:
    cols = [d[0] for d in cursor.description]
    results = []
    for row in rows:
        d = dict(zip(cols, row))
        if "tags" in d and isinstance(d["tags"], str):
            try:
                d["tags"] = json.loads(d["tags"])
            except (json.JSONDecodeError, TypeError):
                d["tags"] = []
        if "elements" in d and isinstance(d["elements"], str):
            try:
                d["elements"] = json.loads(d["elements"])
            except (json.JSONDecodeError, TypeError):
                pass
        results.append(d)
    return results


class SqliteVaultFS(VaultFS):
    """SQLite + local filesystem vault."""

    def __init__(self, user_id: str):
        self.user_id = user_id


    @staticmethod
    async def init(workspace_path: str) -> None:
        """Initialize the SQLite connection and workspace root for the given path."""
        global _db, _workspace_root
        _workspace_root = Path(workspace_path).resolve()
        db_path = os.path.join(workspace_path, ".llmwiki", "index.db")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        _db = await aiosqlite.connect(db_path)
        await _db.execute("PRAGMA journal_mode=WAL")
        await _db.execute("PRAGMA foreign_keys=ON")
        if _SCHEMA_PATH.exists():
            await _db.executescript(_SCHEMA_PATH.read_text())
            await _db.commit()
        logger.info("SQLite initialized: %s", db_path)

    @staticmethod
    async def close() -> None:
        global _db
        if _db:
            await _db.close()
            _db = None

    @staticmethod
    def _db_or_raise() -> aiosqlite.Connection:
        if _db is None:
            raise RuntimeError("SQLite not initialized — call SqliteVaultFS.init() first")
        return _db


    # ── Permission resolution ─────────────────────────────────────────────

    async def accessible_scopes(self, user_email: str | None = None) -> set[str] | None:
        """Return the set of access_scope values this user can see.

        Returns None if enterprise mode is not active (no directory_meta),
        meaning no filtering should be applied (backward compatible).
        """
        db = self._db_or_raise()

        # Check if enterprise tables exist
        cursor = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'"
        )
        if not await cursor.fetchone():
            return None  # No enterprise mode

        cursor = await db.execute("SELECT COUNT(*) FROM directory_meta")
        count = (await cursor.fetchone())[0]
        if count == 0:
            return None  # Enterprise tables exist but empty

        # Global is always accessible to org members
        scopes = {"global"}

        if not user_email:
            # No specific user identity — return only global
            return scopes

        # Check if user is admin (full access)
        cursor = await db.execute(
            "SELECT role FROM org_members WHERE email = ?", (user_email,)
        )
        row = await cursor.fetchone()
        if not row:
            # Not an org member — only global if they have explicit grants
            return scopes

        org_role = row[0]
        if org_role in ("owner", "admin"):
            return None  # Admin sees everything — no filtering

        # Department access
        cursor = await db.execute(
            "SELECT d.slug FROM department_members dm "
            "JOIN departments d ON dm.department_id = d.id "
            "WHERE dm.email = ?",
            (user_email,),
        )
        for dept_row in await cursor.fetchall():
            scopes.add(f"department:{dept_row[0]}")

        # Personal scope
        scopes.add(f"personal:{user_email}")

        # Workgroup grants → directory permissions → match to scopes
        cursor = await db.execute(
            "SELECT dp.directory_path FROM directory_permissions dp "
            "JOIN workgroup_members wm ON dp.grantee_workgroup_slug = ("
            "  SELECT slug FROM workgroups WHERE id = wm.workgroup_id"
            ") WHERE wm.email = ?",
            (user_email,),
        )
        for perm_row in await cursor.fetchall():
            # Resolve the directory path's scope
            dir_path = perm_row[0]
            cursor2 = await db.execute(
                "SELECT dm.scope, d.slug as dept_slug FROM directory_meta dm "
                "LEFT JOIN departments d ON dm.department_id = d.id "
                "WHERE dm.path = ? OR (? LIKE dm.path || '%')",
                (dir_path.rstrip("/"), dir_path.rstrip("/")),
            )
            for meta_row in await cursor2.fetchall():
                if meta_row[0] == "department" and meta_row[1]:
                    scopes.add(f"department:{meta_row[1]}")
                elif meta_row[0] == "restricted":
                    scopes.add(f"restricted:{dir_path.rstrip('/')}")

        # Direct user grants
        cursor = await db.execute(
            "SELECT directory_path FROM directory_permissions WHERE grantee_email = ?",
            (user_email,),
        )
        for perm_row in await cursor.fetchall():
            dir_path = perm_row[0]
            cursor2 = await db.execute(
                "SELECT scope, department_id FROM directory_meta WHERE path = ?",
                (dir_path.rstrip("/"),),
            )
            meta_row = await cursor2.fetchone()
            if meta_row:
                if meta_row[0] == "department":
                    cursor3 = await db.execute(
                        "SELECT slug FROM departments WHERE id = ?", (meta_row[1],)
                    )
                    dept = await cursor3.fetchone()
                    if dept:
                        scopes.add(f"department:{dept[0]}")
                elif meta_row[0] == "restricted":
                    scopes.add(f"restricted:{dir_path.rstrip('/')}")

        return scopes

    def _scope_filter_sql(self, scopes: set[str] | None) -> tuple[str, list]:
        """Build SQL WHERE clause fragment for access_scope filtering.

        Returns (sql_fragment, params). Fragment starts with 'AND'.
        If scopes is None, returns empty string (no filtering).
        """
        if scopes is None:
            return "", []

        placeholders = ",".join("?" for _ in scopes)
        return f" AND (access_scope IN ({placeholders}) OR access_scope IS NULL)", list(scopes)

    async def can_access_path(self, dir_path: str, user_email: str | None = None) -> bool:
        """Check if user can read from the given directory path."""
        db = self._db_or_raise()

        # Check if enterprise mode is active
        cursor = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'"
        )
        if not await cursor.fetchone():
            return True  # No enterprise mode — full access

        cursor = await db.execute("SELECT COUNT(*) FROM directory_meta")
        if (await cursor.fetchone())[0] == 0:
            return True

        # Root is accessible to all org members
        normalized = dir_path.rstrip("/") or "/"
        if normalized == "/" or normalized == "":
            return True

        if not user_email:
            return True  # No identity info — allow (local single-user mode)

        # Admin has full access
        cursor = await db.execute(
            "SELECT role FROM org_members WHERE email = ?", (user_email,)
        )
        row = await cursor.fetchone()
        if row and row[0] in ("owner", "admin"):
            return True

        # Find the directory_meta for this path or nearest parent
        parts = normalized.lstrip("/").split("/")
        for depth in range(len(parts), 0, -1):
            check = "/" + "/".join(parts[:depth])
            cursor = await db.execute(
                "SELECT scope, department_id, owner_email FROM directory_meta WHERE path = ?",
                (check,),
            )
            meta = await cursor.fetchone()
            if not meta:
                continue

            scope, dept_id, owner_email = meta

            if scope == "global":
                return True
            if scope == "personal":
                return owner_email == user_email
            if scope == "department" and dept_id:
                cursor = await db.execute(
                    "SELECT 1 FROM department_members WHERE department_id = ? AND email = ?",
                    (dept_id, user_email),
                )
                if await cursor.fetchone():
                    return True
            if scope == "restricted":
                # Check explicit grants
                cursor = await db.execute(
                    "SELECT 1 FROM directory_permissions WHERE directory_path = ? AND grantee_email = ?",
                    (check + "/", user_email),
                )
                if await cursor.fetchone():
                    return True
                # Check department grants
                cursor = await db.execute(
                    "SELECT 1 FROM directory_permissions dp "
                    "JOIN department_members dm ON dp.grantee_department_slug = ("
                    "  SELECT slug FROM departments WHERE id = dm.department_id"
                    ") WHERE dp.directory_path = ? AND dm.email = ?",
                    (check + "/", user_email),
                )
                if await cursor.fetchone():
                    return True
                # Check workgroup grants
                cursor = await db.execute(
                    "SELECT 1 FROM directory_permissions dp "
                    "JOIN workgroup_members wm ON dp.grantee_workgroup_slug = ("
                    "  SELECT slug FROM workgroups WHERE id = wm.workgroup_id"
                    ") WHERE dp.directory_path = ? AND wm.email = ?",
                    (check + "/", user_email),
                )
                if await cursor.fetchone():
                    return True

            return False  # Found a meta entry but user has no access

        return True  # No meta entry found — default allow

    async def can_write_path(self, dir_path: str, user_email: str | None = None) -> bool:
        """Check if user can write to the given directory path."""
        db = self._db_or_raise()

        # Check if enterprise mode is active
        cursor = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'"
        )
        if not await cursor.fetchone():
            return True

        cursor = await db.execute("SELECT COUNT(*) FROM directory_meta")
        if (await cursor.fetchone())[0] == 0:
            return True

        normalized = dir_path.rstrip("/") or "/"

        if not user_email:
            return True  # Local single-user mode

        # Admin can write anywhere
        cursor = await db.execute(
            "SELECT role FROM org_members WHERE email = ?", (user_email,)
        )
        row = await cursor.fetchone()
        if row and row[0] in ("owner", "admin"):
            return True

        # Root directory: only admin can write
        if normalized == "/" or normalized == "":
            return False

        # Find meta for path
        parts = normalized.lstrip("/").split("/")
        for depth in range(len(parts), 0, -1):
            check = "/" + "/".join(parts[:depth])
            cursor = await db.execute(
                "SELECT scope, department_id, owner_email FROM directory_meta WHERE path = ?",
                (check,),
            )
            meta = await cursor.fetchone()
            if not meta:
                continue

            scope, dept_id, owner_email = meta

            if scope == "global":
                return False  # Only admin can write global (already checked above)
            if scope == "personal":
                return owner_email == user_email
            if scope == "department" and dept_id:
                # Only editors can write
                cursor = await db.execute(
                    "SELECT role FROM department_members WHERE department_id = ? AND email = ?",
                    (dept_id, user_email),
                )
                dept_row = await cursor.fetchone()
                return dept_row is not None and dept_row[0] == "editor"
            if scope == "restricted":
                # Check explicit editor/admin grants
                cursor = await db.execute(
                    "SELECT role FROM directory_permissions "
                    "WHERE directory_path = ? AND grantee_email = ?",
                    (check + "/", user_email),
                )
                perm = await cursor.fetchone()
                return perm is not None and perm[0] in ("editor", "admin")

            return False

        return True  # No meta — default allow

    async def resolve_kb(self, slug: str) -> dict | None:
        db = self._db_or_raise()
        cursor = await db.execute("SELECT id, name, user_id FROM workspace LIMIT 1")
        row = await cursor.fetchone()
        if not row:
            return None
        cols = [d[0] for d in cursor.description]
        ws = dict(zip(cols, row))
        return {"id": ws["id"], "name": ws["name"], "slug": ws["name"]}

    async def list_knowledge_bases(self) -> list[dict]:
        db = self._db_or_raise()
        cursor = await db.execute(
            "SELECT w.name, w.name as slug, "
            "(SELECT count(*) FROM documents WHERE source_kind != 'wiki' AND status = 'ready') as source_count, "
            "(SELECT count(*) FROM documents WHERE source_kind = 'wiki' AND status = 'ready') as wiki_count "
            "FROM workspace w",
        )
        return _rows_to_dicts(cursor, await cursor.fetchall())


    async def get_document(self, kb_id: str, filename: str, dir_path: str) -> dict | None:
        db = self._db_or_raise()
        cursor = await db.execute(
            "SELECT id, user_id, filename, title, path, content, tags, version, "
            "file_type, page_count, created_at, updated_at "
            "FROM documents WHERE filename = ? AND path = ? AND status = 'ready'",
            (filename, dir_path),
        )
        rows = _rows_to_dicts(cursor, await cursor.fetchall())
        return rows[0] if rows else None

    async def find_document_by_name(self, kb_id: str, name: str) -> dict | None:
        db = self._db_or_raise()
        name_lower = name.lower()
        cursor = await db.execute(
            "SELECT id, user_id, filename, title, path, content, tags, version, "
            "file_type, page_count, created_at, updated_at "
            "FROM documents WHERE (lower(filename) = ? OR lower(title) = ?) AND status = 'ready'",
            (name_lower, name_lower),
        )
        rows = _rows_to_dicts(cursor, await cursor.fetchall())
        return rows[0] if rows else None

    async def create_document(self, kb_id: str, filename: str, title: str, dir_path: str, file_type: str, content: str, tags: list[str], date: str | None = None, metadata: dict | None = None) -> dict:
        db = self._db_or_raise()
        doc_id = str(uuid.uuid4())
        relative_path = (dir_path.rstrip("/") + "/" + filename).lstrip("/")
        source_kind = "wiki" if dir_path.strip("/").startswith("wiki") else "source"

        cursor = await db.execute("SELECT COALESCE(MAX(document_number), 0) + 1 FROM documents")
        row = await cursor.fetchone()
        doc_number = row[0]

        await db.execute(
            "INSERT INTO documents (id, user_id, filename, title, path, relative_path, source_kind, "
            "file_type, status, content, tags, date, metadata, version, document_number) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, 0, ?)",
            (doc_id, self.user_id, filename, title, dir_path, relative_path, source_kind,
             file_type, content, json.dumps(tags), date,
             json.dumps(metadata) if metadata else None, doc_number),
        )
        await db.commit()
        return {"id": doc_id, "filename": filename, "path": dir_path}

    async def update_document(self, doc_id: str, content: str, tags: list[str] | None = None, title: str | None = None, date: str | None = None, metadata: dict | None = None) -> dict | None:
        db = self._db_or_raise()
        sets = ["content = ?", "version = version + 1", "updated_at = datetime('now')"]
        args: list = [content]

        if title is not None:
            sets.append("title = ?")
            args.append(title)
        if tags is not None:
            sets.append("tags = ?")
            args.append(json.dumps(tags))
        if date is not None:
            sets.append("date = ?")
            args.append(date)
        if metadata is not None:
            sets.append("metadata = ?")
            args.append(json.dumps(metadata))

        args.append(doc_id)
        await db.execute(
            f"UPDATE documents SET {', '.join(sets)} WHERE id = ?",
            tuple(args),
        )
        await db.commit()
        return None

    async def archive_documents(self, doc_ids: list[str]) -> int:
        db = self._db_or_raise()
        if not doc_ids:
            return 0
        placeholders = ",".join("?" for _ in doc_ids)
        cursor = await db.execute(f"DELETE FROM documents WHERE id IN ({placeholders})", doc_ids)
        await db.commit()
        return cursor.rowcount


    async def list_documents(self, kb_id: str, scopes: set[str] | None = None) -> list[dict]:
        db = self._db_or_raise()
        scope_sql, scope_params = self._scope_filter_sql(scopes)
        cursor = await db.execute(
            "SELECT id, filename, title, path, file_type, tags, page_count, updated_at, access_scope, metadata "
            f"FROM documents WHERE status = 'ready'{scope_sql} ORDER BY path, filename",
            scope_params,
        )
        return _rows_to_dicts(cursor, await cursor.fetchall())

    async def list_documents_with_content(self, kb_id: str, scopes: set[str] | None = None) -> list[dict]:
        db = self._db_or_raise()
        scope_sql, scope_params = self._scope_filter_sql(scopes)
        cursor = await db.execute(
            "SELECT id, filename, title, path, content, tags, file_type, page_count, access_scope, metadata "
            f"FROM documents WHERE status = 'ready'{scope_sql} ORDER BY path, filename",
            scope_params,
        )
        return _rows_to_dicts(cursor, await cursor.fetchall())


    async def get_pages(self, doc_id: str, page_nums: list[int]) -> list[dict]:
        db = self._db_or_raise()
        if not page_nums:
            return []
        placeholders = ",".join("?" for _ in page_nums)
        cursor = await db.execute(
            f"SELECT page, content, elements FROM document_pages "
            f"WHERE document_id = ? AND page IN ({placeholders}) ORDER BY page",
            [doc_id] + page_nums,
        )
        return _rows_to_dicts(cursor, await cursor.fetchall())

    async def get_all_pages(self, doc_id: str) -> list[dict]:
        db = self._db_or_raise()
        cursor = await db.execute(
            "SELECT page, content FROM document_pages WHERE document_id = ? ORDER BY page",
            (doc_id,),
        )
        return _rows_to_dicts(cursor, await cursor.fetchall())


    async def search_chunks(self, kb_id: str, query: str, limit: int, path_filter: str | None = None, scopes: set[str] | None = None, max_sensitivity: str | None = None) -> list[dict]:
        db = self._db_or_raise()
        sql = (
            "SELECT dc.content, dc.page, dc.header_breadcrumb, dc.chunk_index, "
            "d.filename, d.title, d.path, d.file_type, d.tags, d.access_scope, d.metadata, "
            "rank as score "
            "FROM document_chunks dc "
            "JOIN chunks_fts fts ON dc.rowid = fts.rowid "
            "JOIN documents d ON dc.document_id = d.id "
            "WHERE chunks_fts MATCH ? AND d.status = 'ready' "
        )
        params: list = [query]
        if path_filter == "wiki":
            sql += "AND d.source_kind = 'wiki' "
        elif path_filter == "sources":
            sql += "AND d.source_kind != 'wiki' "

        # Sensitivity filtering: restricted docs never appear in RAG
        sql += "AND COALESCE(d.sensitivity, 'public') != 'restricted' "
        if max_sensitivity == "public":
            sql += "AND COALESCE(d.sensitivity, 'public') = 'public' "

        # Apply enterprise scope filtering
        scope_sql, scope_params = self._scope_filter_sql(scopes)
        if scope_sql:
            sql += scope_sql.replace(" AND ", "AND ", 1)
            params.extend(scope_params)

        sql += "ORDER BY rank LIMIT ?"
        params.append(limit)

        cursor = await db.execute(sql, params)
        return _rows_to_dicts(cursor, await cursor.fetchall())


    async def search_chunks_hybrid(self, kb_id: str, query: str, limit: int, path_filter: str | None = None, scopes: set[str] | None = None) -> list[dict]:
        """Hybrid search: combine FTS5 keyword results with vector similarity.

        If embeddings are not available, falls back to pure FTS5.
        Returns results sorted by combined score, deduplicated by chunk.
        """
        # 1. FTS5 keyword search
        fts_results = await self.search_chunks(kb_id, query, limit * 2, path_filter, scopes)

        # 2. Try vector similarity search
        try:
            import sys, os
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'api'))
            from services.embedder import is_available, generate_embedding, blob_to_embedding, cosine_similarity

            if not is_available():
                return fts_results[:limit]

            query_vec = await generate_embedding(query)
            if not query_vec:
                return fts_results[:limit]

            db = self._db_or_raise()
            # Fetch all chunks with embeddings
            scope_sql, scope_params = self._scope_filter_sql(scopes)
            sql = (
                "SELECT dc.rowid, dc.content, dc.page, dc.header_breadcrumb, dc.chunk_index, dc.embedding, "
                "d.filename, d.title, d.path, d.file_type, d.tags, d.access_scope, d.metadata "
                "FROM document_chunks dc "
                "JOIN documents d ON dc.document_id = d.id "
                "WHERE dc.embedding IS NOT NULL AND d.status = 'ready' "
                "AND COALESCE(d.sensitivity, 'public') != 'restricted' "
            )
            params: list = []
            if path_filter == "wiki":
                sql += "AND d.source_kind = 'wiki' "
            elif path_filter == "sources":
                sql += "AND d.source_kind != 'wiki' "
            if scope_sql:
                sql += scope_sql.replace(" AND ", "AND ", 1)
                params.extend(scope_params)

            cursor = await db.execute(sql, params)
            rows = await cursor.fetchall()
            cols = [desc[0] for desc in cursor.description]

            # Score by cosine similarity
            vec_results = []
            for row in rows:
                row_dict = dict(zip(cols, row))
                emb_blob = row_dict.pop("embedding")
                chunk_vec = blob_to_embedding(emb_blob)
                sim = cosine_similarity(query_vec, chunk_vec)
                row_dict["score"] = sim
                vec_results.append(row_dict)

            vec_results.sort(key=lambda x: x["score"], reverse=True)
            vec_top = vec_results[:limit * 2]

            # 3. Merge and deduplicate
            seen = set()
            merged = []
            # Interleave: take from both, prioritizing higher scores
            fts_idx = 0
            vec_idx = 0
            while len(merged) < limit and (fts_idx < len(fts_results) or vec_idx < len(vec_top)):
                candidates = []
                if fts_idx < len(fts_results):
                    candidates.append(('fts', fts_idx, abs(fts_results[fts_idx].get("score", 0))))
                if vec_idx < len(vec_top):
                    candidates.append(('vec', vec_idx, vec_top[vec_idx].get("score", 0)))

                # Normalize: FTS rank is negative (lower=better), cosine is 0-1 (higher=better)
                # Just alternate between sources for diversity
                if len(merged) % 2 == 0 and vec_idx < len(vec_top):
                    pick = vec_top[vec_idx]
                    vec_idx += 1
                elif fts_idx < len(fts_results):
                    pick = fts_results[fts_idx]
                    fts_idx += 1
                elif vec_idx < len(vec_top):
                    pick = vec_top[vec_idx]
                    vec_idx += 1
                else:
                    break

                key = f"{pick.get('path','')}{pick.get('filename','')}_p{pick.get('page','')}_c{pick.get('chunk_index','')}"
                if key not in seen:
                    seen.add(key)
                    merged.append(pick)

            return merged

        except Exception as e:
            import logging
            logging.getLogger(__name__).debug(f"Hybrid search vector path failed: {e}, using FTS only")
            return fts_results[:limit]


    async def load_source_bytes(self, doc: dict) -> bytes | None:
        relative = doc.get("relative_path") or (doc["path"].rstrip("/") + "/" + doc["filename"]).lstrip("/")
        return self._load_local_bytes(relative)

    async def load_image_bytes(self, doc_id: str, image_id: str) -> bytes | None:
        return None

    def _load_local_bytes(self, key: str) -> bytes | None:
        if _workspace_root is None:
            return None
        cache_path = _workspace_root / ".llmwiki" / "cache" / key
        if cache_path.is_file() and cache_path.is_relative_to(_workspace_root):
            return cache_path.read_bytes()
        root_path = _workspace_root / key
        if root_path.is_file() and root_path.is_relative_to(_workspace_root):
            return root_path.read_bytes()
        return None


    def write_to_disk(self, dir_path: str, filename: str, content: str) -> bool:
        file_path = self._resolve_path(dir_path.lstrip("/") + filename)
        if not file_path:
            return False
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
        return True

    def delete_from_disk(self, docs: list[dict]) -> None:
        for d in docs:
            relative = d["path"].lstrip("/") + d["filename"]
            file_path = self._resolve_path(relative)
            if file_path and file_path.exists():
                file_path.unlink()

    def _resolve_path(self, relative_path: str) -> Path | None:
        if _workspace_root is None:
            return None
        resolved = (_workspace_root / relative_path).resolve()
        if not resolved.is_relative_to(_workspace_root):
            return None
        return resolved


    async def delete_references(self, source_doc_id: str) -> None:
        db = self._db_or_raise()
        await db.execute("DELETE FROM document_references WHERE source_document_id = ?", (source_doc_id,))
        await db.commit()

    async def upsert_reference(self, source_id: str, target_id: str, kb_id: str, ref_type: str, page: int | None) -> None:
        db = self._db_or_raise()
        try:
            await db.execute(
                "INSERT OR REPLACE INTO document_references "
                "(source_document_id, target_document_id, reference_type, page) "
                "VALUES (?, ?, ?, ?)",
                (source_id, target_id, ref_type, page),
            )
            await db.commit()
        except Exception as e:
            logger.warning("Failed to insert reference %s -> %s: %s", source_id[:8], target_id[:8], e)

    async def propagate_staleness(self, doc_id: str) -> None:
        db = self._db_or_raise()
        await db.execute(
            "UPDATE documents SET stale_since = datetime('now') "
            "WHERE id IN ("
            "  SELECT source_document_id FROM document_references "
            "  WHERE target_document_id = ? AND reference_type = 'links_to'"
            ") AND stale_since IS NULL",
            (doc_id,),
        )
        await db.commit()

    async def get_backlinks(self, doc_id: str) -> list[dict]:
        db = self._db_or_raise()
        cursor = await db.execute(
            "SELECT d.path, d.filename, d.title, dr.reference_type "
            "FROM document_references dr "
            "JOIN documents d ON dr.source_document_id = d.id "
            "WHERE dr.target_document_id = ? AND d.status = 'ready' "
            "ORDER BY d.path, d.filename",
            (doc_id,),
        )
        return _rows_to_dicts(cursor, await cursor.fetchall())

    async def get_forward_references(self, doc_id: str) -> list[dict]:
        db = self._db_or_raise()
        cursor = await db.execute(
            "SELECT d.filename, d.title, d.path, dr.reference_type, dr.page "
            "FROM document_references dr "
            "JOIN documents d ON dr.target_document_id = d.id "
            "WHERE dr.source_document_id = ? AND d.status = 'ready' "
            "ORDER BY dr.reference_type, d.path, d.filename",
            (doc_id,),
        )
        return _rows_to_dicts(cursor, await cursor.fetchall())

    async def find_uncited_sources(self, kb_id: str, scopes: set[str] | None = None) -> list[dict]:
        db = self._db_or_raise()
        scope_sql, scope_params = self._scope_filter_sql(scopes)
        cursor = await db.execute(
            "SELECT d.filename, d.title, d.path, d.file_type, d.access_scope, d.metadata "
            "FROM documents d "
            f"WHERE d.source_kind != 'wiki' AND d.source_kind != 'asset' AND d.status = 'ready'{scope_sql} "
            "  AND d.id NOT IN (SELECT target_document_id FROM document_references WHERE reference_type = 'cites') "
            "ORDER BY d.filename",
            scope_params,
        )
        return _rows_to_dicts(cursor, await cursor.fetchall())

    async def find_stale_pages(self, kb_id: str, scopes: set[str] | None = None) -> list[dict]:
        db = self._db_or_raise()
        scope_sql, scope_params = self._scope_filter_sql(scopes)
        cursor = await db.execute(
            "SELECT d.filename, d.title, d.path, d.stale_since, d.access_scope "
            "FROM documents d "
            f"WHERE d.status = 'ready' AND d.stale_since IS NOT NULL{scope_sql} "
            "ORDER BY d.stale_since DESC",
            scope_params,
        )
        return _rows_to_dicts(cursor, await cursor.fetchall())

    async def search_documents_full(self, kb_id: str, query: str, limit: int, path_filter: str | None = None, scopes: set[str] | None = None) -> list[dict]:
        db = self._db_or_raise()
        sql = (
            "SELECT d.id, d.filename, d.title, d.path, d.content, d.tags, "
            "d.file_type, d.source_kind, d.page_count, d.access_scope, d.metadata, "
            "MIN(fts.rank) as best_score "
            "FROM document_chunks dc "
            "JOIN chunks_fts fts ON dc.rowid = fts.rowid "
            "JOIN documents d ON dc.document_id = d.id "
            "WHERE chunks_fts MATCH ? AND d.status = 'ready' "
        )
        params: list = [query]
        if path_filter == "wiki":
            sql += "AND d.source_kind = 'wiki' "
        elif path_filter == "sources":
            sql += "AND d.source_kind != 'wiki' "
        scope_sql, scope_params = self._scope_filter_sql(scopes)
        if scope_sql:
            sql += scope_sql.replace(" AND ", "AND ", 1)
            params.extend(scope_params)
        sql += "GROUP BY d.id ORDER BY best_score LIMIT ?"
        params.append(limit)

        cursor = await db.execute(sql, params)
        return _rows_to_dicts(cursor, await cursor.fetchall())

    async def search_documents_by_content(self, kb_id: str, keywords: list[str], limit: int, path_filter: str | None = None, scopes: set[str] | None = None) -> list[dict]:
        db = self._db_or_raise()
        if not keywords:
            return []

        # Build LIKE conditions — match ANY keyword, score by count of matches
        like_cases = []
        params: list = []
        for kw in keywords:
            like_cases.append("(CASE WHEN lower(d.content) LIKE ? THEN 1 ELSE 0 END)")
            params.append(f"%{kw.lower()}%")

        score_expr = " + ".join(like_cases)
        where_clauses = " OR ".join(f"lower(d.content) LIKE ?" for _ in keywords)
        for kw in keywords:
            params.append(f"%{kw.lower()}%")

        sql = (
            f"SELECT d.id, d.filename, d.title, d.path, d.content, d.tags, "
            f"d.file_type, d.source_kind, d.page_count, "
            f"({score_expr}) as match_score "
            f"FROM documents d "
            f"WHERE d.status = 'ready' AND d.content IS NOT NULL "
            f"AND ({where_clauses}) "
        )
        if path_filter == "wiki":
            sql += "AND d.source_kind = 'wiki' "
        elif path_filter == "sources":
            sql += "AND d.source_kind != 'wiki' "
        scope_sql, scope_params = self._scope_filter_sql(scopes)
        if scope_sql:
            sql += scope_sql.replace(" AND ", "AND ", 1)
            params.extend(scope_params)
        sql += "ORDER BY match_score DESC LIMIT ?"
        params.append(limit)

        cursor = await db.execute(sql, params)
        return _rows_to_dicts(cursor, await cursor.fetchall())


    async def get_workspace(self) -> dict | None:
        """Get the workspace record, if it exists."""
        return await self.resolve_kb("")

    async def ensure_workspace(self, workspace_name: str) -> str:
        """Ensure a workspace row exists. Returns the workspace ID."""
        db = self._db_or_raise()
        cursor = await db.execute("SELECT id FROM workspace LIMIT 1")
        row = await cursor.fetchone()
        if row:
            return row[0]
        ws_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO workspace (id, name, description, user_id) VALUES (?, ?, '', ?)",
            (ws_id, workspace_name, self.user_id),
        )
        await db.commit()
        return ws_id
