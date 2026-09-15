"""PostgreSQL + local filesystem implementation of VaultFS.

Uses asyncpg with jz_kb_* tables from the main platform's migration 013.
Designed for local/on-premise deployments sharing the main platform's PostgreSQL.
"""

import json
import logging
import uuid
from pathlib import Path

import asyncpg

from .base import VaultFS
from config import settings

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None
_workspace_root: Path | None = None


def _record_to_dict(row: asyncpg.Record) -> dict:
    """Convert an asyncpg Record to a plain dict, normalizing known fields."""
    d = dict(row)
    # tags may be a native PG array (list) or JSON string
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
    return d


def _records_to_dicts(rows: list[asyncpg.Record]) -> list[dict]:
    return [_record_to_dict(r) for r in rows]


class PgLocalVaultFS(VaultFS):
    """PostgreSQL + local filesystem vault for on-premise deployments."""

    _database_url: str = ""

    def __init__(self, user_id: str):
        self.user_id = user_id

    # ── Lifecycle ─────────────────────────────────────────────────────────

    @staticmethod
    async def init(database_url: str, workspace_path: str) -> None:
        """Store connection params and set workspace root. Pool created lazily on first use."""
        global _pool, _workspace_root
        _workspace_root = Path(workspace_path).resolve()
        PgLocalVaultFS._database_url = database_url
        # Create pool for init-time queries (may be on a different event loop)
        _pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)
        logger.info("PgLocal initialized: pool to %s, workspace %s", database_url.split("@")[-1], _workspace_root)

    @staticmethod
    async def close() -> None:
        global _pool
        if _pool:
            await _pool.close()
            _pool = None

    @staticmethod
    async def _ensure_pool() -> asyncpg.Pool:
        """Get or lazily create pool in current event loop."""
        global _pool
        if _pool is not None:
            # Test if pool is usable in current event loop
            try:
                await _pool.fetchval("SELECT 1")
                return _pool
            except Exception:
                # Pool from different event loop — recreate
                try:
                    await _pool.close()
                except Exception:
                    pass
                _pool = None
        if PgLocalVaultFS._database_url:
            _pool = await asyncpg.create_pool(PgLocalVaultFS._database_url, min_size=2, max_size=10)
            logger.info("PgLocal pool recreated in current event loop")
            return _pool
        raise RuntimeError("PgLocal not initialized -- call PgLocalVaultFS.init() first")

    @staticmethod
    async def _get_pool() -> asyncpg.Pool:
        """Get pool, lazily creating in current event loop if needed."""
        global _pool
        import asyncio
        loop = asyncio.get_running_loop()
        logger.debug("_get_pool called: _pool=%s, loop=%s, db_url=%s", _pool is not None, id(loop), bool(PgLocalVaultFS._database_url))
        if _pool is None and PgLocalVaultFS._database_url:
            _pool = await asyncpg.create_pool(PgLocalVaultFS._database_url, min_size=2, max_size=10)
            logger.info("PgLocal pool created lazily in loop %s", id(loop))
        if _pool is None:
            raise RuntimeError("PgLocal not initialized")
        return _pool

    @staticmethod
    def _pool_or_raise() -> asyncpg.Pool:
        if _pool is None:
            raise RuntimeError("PgLocal not initialized -- call PgLocalVaultFS.init() first")
        return _pool

    # ── Knowledge Base (static, single-tenant) ────────────────────────────

    async def resolve_kb(self, slug: str) -> dict | None:
        return {"id": "default", "slug": "default", "name": "Enterprise Mind"}

    async def list_knowledge_bases(self) -> list[dict]:
        pool = await self._get_pool()
        row = await pool.fetchrow(
            "SELECT "
            "(SELECT count(*) FROM jz_kb_documents WHERE source_kind != 'wiki' AND status = 'ready') AS source_count, "
            "(SELECT count(*) FROM jz_kb_documents WHERE source_kind = 'wiki' AND status = 'ready') AS wiki_count"
        )
        return [{
            "name": "Enterprise Mind", "slug": "default",
            "source_count": row["source_count"] if row else 0,
            "wiki_count": row["wiki_count"] if row else 0,
        }]

    async def ensure_workspace(self, name: str) -> str:
        return "default"

    async def get_workspace(self) -> dict | None:
        """Return a static workspace dict (PG mode doesn't use workspace table)."""
        return {"id": "default", "name": "default", "user_id": self.user_id}

    # ── Permission Resolution (category-based) ────────────────────────────

    async def accessible_scopes(
        self, user_id: str | None = None, explicit_scopes: list[str] | None = None
    ) -> set[str] | None:
        """Return set of accessible category_ids.

        - explicit_scopes: when provided by a trusted caller (e.g. signed REST proxy),
          use it directly. ADMIN_ALL disables filtering.
        - Otherwise resolve from jz_kb_category_access.
        - Fail-closed: no ACL rows -> empty set (unless KB_ACL_FAIL_CLOSED=false).
        - Admin -> ADMIN_ALL sentinel, distinguishable from "not configured".
        """
        if explicit_scopes is not None:
            if "ADMIN_ALL" in explicit_scopes:
                return {"ADMIN_ALL"}
            return set(explicit_scopes)

        if not user_id:
            return set() if settings.KB_ACL_FAIL_CLOSED else None

        pool = await self._get_pool()

        # Check if category_access table has any rows
        count = await pool.fetchval("SELECT count(*) FROM jz_kb_category_access")
        if count == 0:
            return set() if settings.KB_ACL_FAIL_CLOSED else None

        # Check if user is admin
        role = await pool.fetchval(
            "SELECT role FROM jz_users WHERE id = $1", user_id
        )
        if role in ("owner", "admin"):
            return {"ADMIN_ALL"}

        # Resolve department & workgroup memberships
        dept_ids = [
            r["department_id"] for r in await pool.fetch(
                "SELECT department_id FROM jz_department_members WHERE user_id = $1", user_id
            )
        ]
        wg_ids = [
            r["workgroup_id"] for r in await pool.fetch(
                "SELECT workgroup_id FROM jz_workgroup_members WHERE user_id = $1", user_id
            )
        ]

        # Recursive category access resolution
        rows = await pool.fetch(
            """
            WITH RECURSIVE accessible AS (
                SELECT DISTINCT category_id FROM jz_kb_category_access
                WHERE (grantee_type = 'user' AND grantee_id = $1)
                   OR (grantee_type = 'department' AND grantee_id = ANY($2::text[]))
                   OR (grantee_type = 'workgroup' AND grantee_id = ANY($3::text[]))
                UNION ALL
                SELECT c.id FROM jz_kb_categories c
                JOIN accessible a ON c.parent_id = a.category_id
            )
            SELECT category_id FROM accessible
            """,
            user_id, dept_ids, wg_ids,
        )
        return {str(r["category_id"]) for r in rows}

    def _scope_filter(self, scopes: set[str] | None, param_idx: int) -> tuple[str, list, int]:
        """Build category-based scope filter SQL.

        Returns (sql_fragment, params, next_param_idx).
        Fragment starts with ' AND'.
        """
        if scopes is None or "ADMIN_ALL" in scopes:
            return "", [], param_idx

        scope_list = list(scopes)
        sql = (
            f" AND (d.category_id IS NULL"
            f" OR d.category_id::text = ANY(${param_idx}::text[])"
            f" OR d.owner_user_id = ${param_idx + 1})"
        )
        return sql, [scope_list, self.user_id], param_idx + 2

    # ── Document Operations ───────────────────────────────────────────────

    async def list_documents(self, kb_id: str, scopes: set[str] | None = None) -> list[dict]:
        pool = await self._get_pool()
        scope_sql, scope_params, _ = self._scope_filter(scopes, 1)
        rows = await pool.fetch(
            "SELECT id, filename, title, path, file_type, tags, page_count, "
            "updated_at, category_id, metadata "
            f"FROM jz_kb_documents WHERE status = 'ready'{scope_sql} "
            "ORDER BY path, filename",
            *scope_params,
        )
        return _records_to_dicts(rows)

    async def list_documents_with_content(self, kb_id: str, scopes: set[str] | None = None) -> list[dict]:
        pool = await self._get_pool()
        scope_sql, scope_params, _ = self._scope_filter(scopes, 1)
        rows = await pool.fetch(
            "SELECT id, filename, title, path, content, tags, file_type, "
            "page_count, category_id, metadata "
            f"FROM jz_kb_documents WHERE status = 'ready'{scope_sql} "
            "ORDER BY path, filename",
            *scope_params,
        )
        return _records_to_dicts(rows)

    async def get_document(self, kb_id: str, filename: str, dir_path: str) -> dict | None:
        pool = await self._get_pool()
        row = await pool.fetchrow(
            "SELECT id, owner_user_id, filename, title, path, content, tags, version, "
            "file_type, page_count, created_at, updated_at "
            "FROM jz_kb_documents WHERE filename = $1 AND path = $2 AND status = 'ready'",
            filename, dir_path,
        )
        return _record_to_dict(row) if row else None

    async def find_document_by_name(self, kb_id: str, name: str) -> dict | None:
        pool = await self._get_pool()
        row = await pool.fetchrow(
            "SELECT id, owner_user_id, filename, title, path, content, tags, version, "
            "file_type, page_count, created_at, updated_at "
            "FROM jz_kb_documents "
            "WHERE (lower(filename) = lower($1) OR lower(title) = lower($1)) AND status = 'ready'",
            name,
        )
        return _record_to_dict(row) if row else None

    async def create_document(
        self, kb_id: str, filename: str, title: str, dir_path: str,
        file_type: str, content: str, tags: list[str],
        date: str | None = None, metadata: dict | None = None,
    ) -> dict:
        pool = await self._get_pool()
        doc_id = str(uuid.uuid4())
        relative_path = (dir_path.rstrip("/") + "/" + filename).lstrip("/")
        source_kind = "wiki" if dir_path.strip("/").startswith("wiki") else "source"

        # Only set owner_user_id for personal docs (if user exists in jz_users)
        owner_id = None
        if "/personal/" in dir_path:
            exists = await pool.fetchval("SELECT 1 FROM jz_users WHERE id = $1", self.user_id)
            if exists:
                owner_id = self.user_id

        await pool.execute(
            "INSERT INTO jz_kb_documents "
            "(id, owner_user_id, filename, title, path, relative_path, source_kind, "
            "file_type, status, content, tags, date, metadata, version) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready', $9, $10, $11, $12::jsonb, 0)",
            doc_id, owner_id, filename, title, dir_path, relative_path, source_kind,
            file_type, content, tags, date,
            json.dumps(metadata) if metadata else None,
        )
        return {"id": doc_id, "filename": filename, "path": dir_path}

    async def update_document(
        self, doc_id: str, content: str,
        tags: list[str] | None = None, title: str | None = None,
        date: str | None = None, metadata: dict | None = None,
    ) -> dict | None:
        pool = await self._get_pool()
        sets = ["content = $1", "version = version + 1", "updated_at = NOW()"]
        args: list = [content, doc_id]
        idx = 3

        if title is not None:
            sets.append(f"title = ${idx}")
            args.append(title)
            idx += 1
        if tags is not None:
            sets.append(f"tags = ${idx}")
            args.append(tags)
            idx += 1
        if date is not None:
            sets.append(f"date = ${idx}")
            args.append(date)
            idx += 1
        if metadata is not None:
            sets.append(f"metadata = ${idx}::jsonb")
            args.append(json.dumps(metadata))
            idx += 1

        await pool.execute(
            f"UPDATE jz_kb_documents SET {', '.join(sets)} WHERE id = $2",
            *args,
        )
        return None

    async def archive_documents(self, doc_ids: list[str]) -> int:
        if not doc_ids:
            return 0
        pool = await self._get_pool()
        result = await pool.execute(
            "DELETE FROM jz_kb_documents WHERE id = ANY($1::text[])", doc_ids,
        )
        # asyncpg execute returns status string like "DELETE 3"
        try:
            return int(result.split()[-1])
        except (ValueError, IndexError):
            return 0

    # ── Pages ─────────────────────────────────────────────────────────────

    async def get_pages(self, doc_id: str, page_nums: list[int]) -> list[dict]:
        if not page_nums:
            return []
        pool = await self._get_pool()
        rows = await pool.fetch(
            "SELECT page, content, elements FROM jz_kb_document_pages "
            "WHERE document_id = $1 AND page = ANY($2) ORDER BY page",
            doc_id, page_nums,
        )
        return _records_to_dicts(rows)

    async def get_all_pages(self, doc_id: str) -> list[dict]:
        pool = await self._get_pool()
        rows = await pool.fetch(
            "SELECT page, content FROM jz_kb_document_pages "
            "WHERE document_id = $1 ORDER BY page",
            doc_id,
        )
        return _records_to_dicts(rows)

    # ── Search (pg_trgm + ILIKE) ──────────────────────────────────────────

    async def search_chunks(
        self, kb_id: str, query: str, limit: int,
        path_filter: str | None = None,
        scopes: set[str] | None = None,
        max_sensitivity: str | None = None,
    ) -> list[dict]:
        pool = await self._get_pool()
        sql = (
            "SELECT dc.content, dc.page, dc.header_breadcrumb, dc.chunk_index, "
            "d.filename, d.title, d.path, d.file_type, d.tags, d.category_id, d.metadata, "
            "similarity(dc.content, $1) AS score "
            "FROM jz_kb_document_chunks dc "
            "JOIN jz_kb_documents d ON dc.document_id = d.id "
            "WHERE dc.content ILIKE '%' || $1 || '%' "
            "AND d.status = 'ready' "
        )
        params: list = [query]
        idx = 2

        if path_filter == "wiki":
            sql += "AND d.source_kind = 'wiki' "
        elif path_filter == "sources":
            sql += "AND d.source_kind != 'wiki' "

        # Sensitivity filtering
        sql += "AND COALESCE(d.sensitivity, 'public') != 'restricted' "
        if max_sensitivity == "public":
            sql += "AND COALESCE(d.sensitivity, 'public') = 'public' "

        # Category-based scope filtering
        scope_sql, scope_params, idx = self._scope_filter(scopes, idx)
        if scope_sql:
            sql += scope_sql
            params.extend(scope_params)

        sql += f"ORDER BY score DESC LIMIT ${idx}"
        params.append(limit)

        rows = await pool.fetch(sql, *params)
        return _records_to_dicts(rows)

    async def search_chunks_hybrid(
        self, kb_id: str, query: str, limit: int,
        path_filter: str | None = None,
        scopes: set[str] | None = None,
    ) -> list[dict]:
        """Hybrid search -- no vector support in local mode, delegates to search_chunks."""
        return await self.search_chunks(kb_id, query, limit, path_filter, scopes)

    async def search_documents_full(
        self, kb_id: str, query: str, limit: int,
        path_filter: str | None = None,
        scopes: set[str] | None = None,
    ) -> list[dict]:
        pool = await self._get_pool()
        sql = (
            "SELECT d.id, d.filename, d.title, d.path, d.content, d.tags, "
            "d.file_type, d.source_kind, d.page_count, d.category_id, d.metadata, "
            "MAX(similarity(dc.content, $1)) AS best_score "
            "FROM jz_kb_document_chunks dc "
            "JOIN jz_kb_documents d ON dc.document_id = d.id "
            "WHERE dc.content ILIKE '%' || $1 || '%' AND d.status = 'ready' "
        )
        params: list = [query]
        idx = 2

        if path_filter == "wiki":
            sql += "AND d.source_kind = 'wiki' "
        elif path_filter == "sources":
            sql += "AND d.source_kind != 'wiki' "

        scope_sql, scope_params, idx = self._scope_filter(scopes, idx)
        if scope_sql:
            sql += scope_sql
            params.extend(scope_params)

        sql += f"GROUP BY d.id ORDER BY best_score DESC LIMIT ${idx}"
        params.append(limit)

        rows = await pool.fetch(sql, *params)
        return _records_to_dicts(rows)

    async def search_documents_by_content(
        self, kb_id: str, keywords: list[str], limit: int,
        path_filter: str | None = None,
        scopes: set[str] | None = None,
    ) -> list[dict]:
        if not keywords:
            return []
        pool = await self._get_pool()

        like_cases = []
        where_parts = []
        params: list = []
        idx = 1
        for kw in keywords:
            like_cases.append(f"(CASE WHEN d.content ILIKE ${idx} THEN 1 ELSE 0 END)")
            where_parts.append(f"d.content ILIKE ${idx}")
            params.append(f"%{kw}%")
            idx += 1

        score_expr = " + ".join(like_cases)
        where_expr = " OR ".join(where_parts)

        sql = (
            f"SELECT d.id, d.filename, d.title, d.path, d.content, d.tags, "
            f"d.file_type, d.source_kind, d.page_count, "
            f"({score_expr}) AS match_score "
            f"FROM jz_kb_documents d "
            f"WHERE d.status = 'ready' AND d.content IS NOT NULL "
            f"AND ({where_expr}) "
        )

        if path_filter == "wiki":
            sql += "AND d.source_kind = 'wiki' "
        elif path_filter == "sources":
            sql += "AND d.source_kind != 'wiki' "

        scope_sql, scope_params, idx = self._scope_filter(scopes, idx)
        if scope_sql:
            sql += scope_sql
            params.extend(scope_params)

        sql += f"ORDER BY match_score DESC LIMIT ${idx}"
        params.append(limit)

        rows = await pool.fetch(sql, *params)
        return _records_to_dicts(rows)

    # ── References ────────────────────────────────────────────────────────

    async def delete_references(self, source_doc_id: str) -> None:
        pool = await self._get_pool()
        await pool.execute(
            "DELETE FROM jz_kb_document_references WHERE source_document_id = $1",
            source_doc_id,
        )

    async def upsert_reference(
        self, source_id: str, target_id: str, kb_id: str,
        ref_type: str, page: int | None,
    ) -> None:
        pool = await self._get_pool()
        try:
            await pool.execute(
                "INSERT INTO jz_kb_document_references "
                "(source_document_id, target_document_id, reference_type, page) "
                "VALUES ($1, $2, $3, $4) "
                "ON CONFLICT (source_document_id, target_document_id, reference_type) "
                "DO UPDATE SET page = EXCLUDED.page",
                source_id, target_id, ref_type, page,
            )
        except Exception as e:
            logger.warning("Failed to insert reference %s -> %s: %s", source_id[:8], target_id[:8], e)

    async def propagate_staleness(self, doc_id: str) -> None:
        pool = await self._get_pool()
        await pool.execute(
            "UPDATE jz_kb_documents SET stale_since = NOW() "
            "WHERE id IN ("
            "  SELECT source_document_id FROM jz_kb_document_references "
            "  WHERE target_document_id = $1 AND reference_type = 'links_to'"
            ") AND stale_since IS NULL",
            doc_id,
        )

    async def propagate_staleness_from_source(self, source_doc_id: str) -> None:
        """Mark wiki pages stale when a source document they cite is updated."""
        pool = await self._get_pool()
        await pool.execute(
            "UPDATE jz_kb_documents SET stale_since = NOW() "
            "WHERE id IN ("
            "  SELECT source_document_id FROM jz_kb_document_references "
            "  WHERE target_document_id = $1 AND reference_type = 'cites'"
            ") AND stale_since IS NULL",
            source_doc_id,
        )

    async def get_source_compilation_status(self, kb_id: str) -> dict:
        """Return compilation status for each source doc: uncited/stale/current."""
        pool = await self._get_pool()
        rows = await pool.fetch(
            "SELECT r.target_document_id AS source_id, "
            "  d.filename AS wiki_filename, d.stale_since "
            "FROM jz_kb_document_references r "
            "JOIN jz_kb_documents d ON r.source_document_id = d.id "
            "WHERE r.reference_type = 'cites' "
            "  AND d.path LIKE '/wiki/%' "
            "  AND r.target_document_id IN ("
            "    SELECT id FROM jz_kb_documents WHERE source_kind = 'source'"
            f"    AND path != '/' AND id IN (SELECT id FROM jz_kb_documents WHERE true)"
            "  )"
        )
        status_map: dict[str, dict] = {}
        for row in rows:
            sid = str(row["source_id"])
            if sid not in status_map:
                status_map[sid] = {"citing_pages": [], "has_stale": False}
            status_map[sid]["citing_pages"].append(str(row["wiki_filename"]))
            if row["stale_since"] is not None:
                status_map[sid]["has_stale"] = True
        # Classify
        result = {}
        for sid, info in status_map.items():
            if info["has_stale"]:
                result[sid] = "needs_update"
            else:
                result[sid] = "current"
        return result

    async def get_backlinks(self, doc_id: str) -> list[dict]:
        pool = await self._get_pool()
        rows = await pool.fetch(
            "SELECT d.path, d.filename, d.title, dr.reference_type "
            "FROM jz_kb_document_references dr "
            "JOIN jz_kb_documents d ON dr.source_document_id = d.id "
            "WHERE dr.target_document_id = $1 AND d.status = 'ready' "
            "ORDER BY d.path, d.filename",
            doc_id,
        )
        return _records_to_dicts(rows)

    async def get_forward_references(self, doc_id: str) -> list[dict]:
        pool = await self._get_pool()
        rows = await pool.fetch(
            "SELECT d.filename, d.title, d.path, dr.reference_type, dr.page "
            "FROM jz_kb_document_references dr "
            "JOIN jz_kb_documents d ON dr.target_document_id = d.id "
            "WHERE dr.source_document_id = $1 AND d.status = 'ready' "
            "ORDER BY dr.reference_type, d.path, d.filename",
            doc_id,
        )
        return _records_to_dicts(rows)

    async def find_uncited_sources(self, kb_id: str, scopes: set[str] | None = None) -> list[dict]:
        pool = await self._get_pool()
        scope_sql, scope_params, _ = self._scope_filter(scopes, 1)
        rows = await pool.fetch(
            "SELECT d.filename, d.title, d.path, d.file_type, d.category_id, d.metadata "
            "FROM jz_kb_documents d "
            "WHERE d.source_kind != 'wiki' AND d.source_kind != 'asset' "
            f"AND d.status = 'ready'{scope_sql} "
            "AND d.id NOT IN ("
            "  SELECT target_document_id FROM jz_kb_document_references "
            "  WHERE reference_type = 'cites'"
            ") ORDER BY d.filename",
            *scope_params,
        )
        return _records_to_dicts(rows)

    async def find_stale_pages(self, kb_id: str, scopes: set[str] | None = None) -> list[dict]:
        pool = await self._get_pool()
        scope_sql, scope_params, _ = self._scope_filter(scopes, 1)
        rows = await pool.fetch(
            "SELECT d.filename, d.title, d.path, d.stale_since, d.category_id "
            "FROM jz_kb_documents d "
            f"WHERE d.status = 'ready' AND d.stale_since IS NOT NULL{scope_sql} "
            "ORDER BY d.stale_since DESC",
            *scope_params,
        )
        return _records_to_dicts(rows)

    # ── File I/O (local filesystem) ───────────────────────────────────────

    async def load_source_bytes(self, doc: dict) -> bytes | None:
        relative = doc.get("relative_path") or (
            doc["path"].rstrip("/") + "/" + doc["filename"]
        ).lstrip("/")
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
