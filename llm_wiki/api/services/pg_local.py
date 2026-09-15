"""PG Local service implementations — PostgreSQL + filesystem.

Drop-in replacement for local.py when KB_DATABASE_URL is set.
Uses jz_kb_* tables in the main platform's PostgreSQL.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from fastapi import HTTPException

from config import settings
from domain.watcher import mark_written
from services.chunker import chunk_text
from .base import UserService, KBService, DocumentService, ServiceFactory
from .types import parse_frontmatter, title_from_filename, extract_tags


def _row_to_dict(row) -> dict:
    """Convert asyncpg Record to dict, parsing JSON fields."""
    if row is None:
        return None
    d = dict(row)
    for k in ("tags", "metadata"):
        if k in d and isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except (json.JSONDecodeError, TypeError):
                pass
    return d


def _rows_to_dicts(rows) -> list[dict]:
    return [_row_to_dict(r) for r in rows]


class PgDocumentRepository:
    """PostgreSQL document repository using jz_kb_* tables."""

    def __init__(self, pool):
        self._pool = pool

    async def list_by_kb(
        self, kb_id: str, *, path: str | None = None,
        scopes: set[str] | None = None, user_id: str | None = None,
    ) -> list[dict]:
        sql = "SELECT * FROM jz_kb_documents WHERE status != 'archived'"
        args = []
        idx = 1
        if path:
            sql += f" AND path = ${idx}"
            args.append(path)
            idx += 1
        scope_sql, scope_params, idx = self._scope_filter(scopes, idx, user_id)
        if scope_sql:
            sql += scope_sql
            args.extend(scope_params)
        sql += " ORDER BY path, filename"
        return _rows_to_dicts(await self._pool.fetch(sql, *args))

    def _scope_filter(
        self, scopes: set[str] | None, param_idx: int, user_id: str | None,
    ) -> tuple[str, list, int]:
        """Build category-based scope filter SQL."""
        if scopes is None or "ADMIN_ALL" in scopes:
            return "", [], param_idx

        scope_list = list(scopes)
        sql = (
            f" AND (category_id IS NULL"
            f" OR category_id::text = ANY(${param_idx}::text[])"
            f" OR owner_user_id = ${param_idx + 1})"
        )
        return sql, [scope_list, user_id], param_idx + 2

    async def get(self, doc_id: str, scopes: set[str] | None = None, user_id: str | None = None) -> dict | None:
        row = await self._pool.fetchrow("SELECT * FROM jz_kb_documents WHERE id = $1", doc_id)
        if row is None:
            return None
        doc = _row_to_dict(row)
        if scopes is not None and "ADMIN_ALL" not in scopes:
            if doc.get("category_id") and str(doc["category_id"]) not in scopes and doc.get("owner_user_id") != user_id:
                return None
        return doc

    async def get_content(self, doc_id: str, scopes: set[str] | None = None, user_id: str | None = None) -> dict | None:
        doc = await self.get(doc_id, scopes=scopes, user_id=user_id)
        if doc is None:
            return None
        row = await self._pool.fetchrow(
            "SELECT id, filename, path, content, file_type FROM jz_kb_documents WHERE id = $1", doc_id)
        return _row_to_dict(row)

    async def find_by_path(self, kb_id: str, user_id: str, filename: str, path: str) -> dict | None:
        row = await self._pool.fetchrow(
            "SELECT * FROM jz_kb_documents WHERE filename = $1 AND path = $2 AND status != 'archived'",
            filename, path)
        return _row_to_dict(row)

    async def create_note(self, kb_id: str, user_id: str, filename: str, path: str,
                          title: str, content: str, tags: list[str]) -> dict:
        doc_id = str(uuid.uuid4())
        relative_path = (path.rstrip("/") + "/" + filename).lstrip("/")
        source_kind = "wiki" if path.strip("/").startswith("wiki") else "source"

        # Only set owner for personal docs if user exists
        owner_id = None
        if "/personal/" in path:
            exists = await self._pool.fetchval("SELECT 1 FROM jz_users WHERE id = $1", user_id)
            if exists:
                owner_id = user_id

        await self._pool.execute(
            "INSERT INTO jz_kb_documents "
            "(id, owner_user_id, filename, title, path, relative_path, source_kind, "
            "file_type, status, content, tags, version) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, 'md', 'ready', $8, $9, 0)",
            doc_id, owner_id, filename, title, path, relative_path, source_kind,
            content, tags or [],
        )
        return {"id": doc_id, "filename": filename, "path": path, "title": title,
                "relative_path": relative_path, "source_kind": source_kind, "status": "ready"}

    async def update_content(self, doc_id: str, user_id: str, content: str) -> dict | None:
        await self._pool.execute(
            "UPDATE jz_kb_documents SET content = $1, updated_at = NOW() WHERE id = $2",
            content, doc_id)
        return await self.get(doc_id)

    async def update_metadata(self, doc_id: str, user_id: str, **fields) -> dict | None:
        if not fields:
            return None
        sets = []
        args = []
        idx = 1
        for k, v in fields.items():
            if k in ('filename', 'path', 'title', 'tags', 'date', 'metadata',
                      'relative_path', 'source_kind', 'status', 'sensitivity'):
                sets.append(f"{k} = ${idx}")
                args.append(v)
                idx += 1
        if not sets:
            return None
        args.append(doc_id)
        await self._pool.execute(
            f"UPDATE jz_kb_documents SET {', '.join(sets)}, updated_at = NOW() WHERE id = ${idx}", *args)
        return await self.get(doc_id)

    async def archive(self, doc_id: str, user_id: str) -> bool:
        r = await self._pool.execute(
            "UPDATE jz_kb_documents SET status = 'archived' WHERE id = $1", doc_id)
        return "UPDATE 1" in r

    async def bulk_archive(self, doc_ids: list[str], user_id: str) -> int:
        r = await self._pool.execute(
            "DELETE FROM jz_kb_documents WHERE id = ANY($1)", doc_ids)
        return int(r.split(" ")[-1]) if r else 0

    async def get_kb_id(self, doc_id: str) -> str | None:
        return "default"  # Single workspace

    async def update_status(self, doc_id: str, status: str, **fields) -> None:
        sets = ["status = $1"]
        args = [status]
        idx = 2
        for k, v in fields.items():
            if k in ('error_message', 'page_count', 'content_hash', 'parser'):
                sets.append(f"{k} = ${idx}")
                args.append(v)
                idx += 1
        args.append(doc_id)
        await self._pool.execute(
            f"UPDATE jz_kb_documents SET {', '.join(sets)}, updated_at = NOW() WHERE id = ${idx}", *args)

    async def get_for_processing(self, doc_id: str, user_id: str) -> dict | None:
        return await self.get(doc_id)


class PgChunkRepository:
    """PostgreSQL chunk repository using jz_kb_document_chunks."""

    def __init__(self, pool):
        self._pool = pool

    async def store(self, doc_id: str, user_id: str, kb_id: str, chunks: list) -> None:
        # Delete old chunks
        await self._pool.execute("DELETE FROM jz_kb_document_chunks WHERE document_id = $1", doc_id)

        for i, chunk in enumerate(chunks):
            chunk_id = str(uuid.uuid4())
            content = chunk.content if hasattr(chunk, 'content') else str(chunk)
            token_count = chunk.token_count if hasattr(chunk, 'token_count') else len(content) // 4
            page = chunk.page if hasattr(chunk, 'page') else None
            start_char = chunk.start_char if hasattr(chunk, 'start_char') else None
            breadcrumb = chunk.header_breadcrumb if hasattr(chunk, 'header_breadcrumb') else None

            await self._pool.execute(
                "INSERT INTO jz_kb_document_chunks "
                "(id, document_id, chunk_index, content, page, start_char, token_count, header_breadcrumb) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                chunk_id, doc_id, i, content, page, start_char, token_count, breadcrumb,
            )


# ── Service implementations ──────────────────────────────────────────────────

class PgLocalUserService(UserService):

    def __init__(self, pool, user_id: str):
        self.pool = pool
        self.user_id = user_id

    async def get_profile(self) -> dict:
        return {"id": self.user_id, "email": "local@localhost",
                "display_name": "Local User", "onboarded": True}

    async def complete_onboarding(self) -> None:
        pass

    async def get_usage(self) -> dict:
        row = await self.pool.fetchrow(
            "SELECT count(*) as doc_count, "
            "COALESCE(SUM(page_count), 0) as total_pages, "
            "COALESCE(SUM(file_size), 0) as total_storage "
            "FROM jz_kb_documents WHERE status != 'failed'")
        return {
            "total_pages": row["total_pages"] if row else 0,
            "total_storage_bytes": row["total_storage"] if row else 0,
            "document_count": row["doc_count"] if row else 0,
            "max_pages": 999999, "max_storage_bytes": 999999999999,
        }


class PgLocalKBService(KBService):

    def __init__(self, pool, user_id: str):
        self.pool = pool
        self.user_id = user_id

    async def list(self) -> list[dict]:
        src = await self.pool.fetchval(
            "SELECT count(*) FROM jz_kb_documents WHERE source_kind != 'wiki' AND status != 'failed'")
        wiki = await self.pool.fetchval(
            "SELECT count(*) FROM jz_kb_documents WHERE source_kind = 'wiki' AND status != 'failed'")
        return [{
            "id": "default", "user_id": self.user_id, "name": "Enterprise Mind",
            "slug": "default", "description": None,
            "source_count": src or 0, "wiki_page_count": wiki or 0,
            "created_at": None, "updated_at": None,
        }]

    async def get(self, kb_id: str) -> dict | None:
        kbs = await self.list()
        return kbs[0] if kbs else None

    async def create(self, name: str, description: str | None) -> dict:
        return (await self.list())[0]

    async def update(self, kb_id: str, name: str | None, description: str | None) -> dict | None:
        return await self.get(kb_id)

    async def delete(self, kb_id: str) -> bool:
        raise HTTPException(status_code=400, detail="Cannot delete workspace in local mode")


def _workspace_root() -> Path:
    return Path(settings.WORKSPACE_PATH).resolve()


def _safe_resolve(relative: str) -> Path:
    ws = _workspace_root()
    resolved = (ws / relative).resolve()
    if not resolved.is_relative_to(ws):
        raise HTTPException(status_code=400, detail="Path escapes workspace")
    return resolved


def _doc_to_disk_path(doc: dict) -> Path | None:
    relative = (doc["path"].rstrip("/") + "/" + doc["filename"]).lstrip("/")
    ws = _workspace_root()
    resolved = (ws / relative).resolve()
    return resolved if resolved.is_relative_to(ws) else None


class PgLocalDocumentService(DocumentService):

    def __init__(self, pool, user_id: str):
        self.pool = pool
        self.user_id = user_id
        self.doc_repo = PgDocumentRepository(pool)
        self.chunk_repo = PgChunkRepository(pool)

    async def list(
        self, kb_id: str, path: str | None = None,
        scopes: set[str] | None = None,
    ) -> list[dict]:
        return await self.doc_repo.list_by_kb(
            kb_id, path=path, scopes=scopes, user_id=self.user_id,
        )

    async def get(self, doc_id: str, scopes: set[str] | None = None) -> dict | None:
        return await self.doc_repo.get(doc_id, scopes=scopes, user_id=self.user_id)

    async def get_content(self, doc_id: str, scopes: set[str] | None = None) -> dict | None:
        return await self.doc_repo.get_content(doc_id, scopes=scopes, user_id=self.user_id)

    async def get_url(self, doc_id: str, scopes: set[str] | None = None) -> dict | None:
        doc = await self.doc_repo.get(doc_id, scopes=scopes, user_id=self.user_id)
        if not doc:
            return None
        api_url = settings.API_URL.rstrip("/")
        relative = doc.get("relative_path") or (doc["path"].rstrip("/") + "/" + doc["filename"]).lstrip("/")
        return {"url": f"{api_url}/v1/files/{relative}"}

    async def create_note(self, kb_id: str, filename: str, path: str, content: str) -> dict:
        meta = parse_frontmatter(content)
        title = meta.get("title", "").strip() or title_from_filename(filename)
        tags = extract_tags(meta)

        # 幂等：相同 path+filename 且内容一致(且非空) → 直接返回已有文档，避免并发/重试重复建档
        # （前端自动播种竞态会重复 POST 同一 identity.md/general.md，否则被改名成 Identity 2/General 2）
        # 仅对非空内容生效：空的 Untitled.md 仍走下方自动改名，保留"同名多份"手动建档语义。
        if content:
            existing = await self.doc_repo.find_by_path(kb_id, self.user_id, filename, path)
            if existing and (existing.get("content") or "") == content:
                return existing

        # Auto-increment filename（仅当同名但内容不同：保留"同名多份自动改名"语义）
        base_filename = filename
        stem = filename.rsplit(".", 1)[0] if "." in filename else filename
        ext = ("." + filename.rsplit(".", 1)[1]) if "." in filename else ""
        counter = 1
        while await self.doc_repo.find_by_path(kb_id, self.user_id, filename, path):
            counter += 1
            filename = f"{stem} {counter}{ext}"
        if filename != base_filename:
            title = title_from_filename(filename)

        relative = (path.rstrip("/") + "/" + filename).lstrip("/")
        file_path = _safe_resolve(relative)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        mark_written(str(file_path))
        file_path.write_text(content or "", encoding="utf-8")

        row = await self.doc_repo.create_note(kb_id, self.user_id, filename, path, title, content, tags)

        if content:
            chunks = chunk_text(content)
            await self.chunk_repo.store(str(row["id"]), self.user_id, kb_id, chunks)

        return row

    async def update_content(self, doc_id: str, content: str) -> dict | None:
        doc = await self.doc_repo.get(doc_id)
        if not doc:
            return None
        file_path = _doc_to_disk_path(doc)
        if file_path:
            mark_written(str(file_path))
            file_path.write_text(content, encoding="utf-8")
        row = await self.doc_repo.update_content(doc_id, self.user_id, content)
        if content:
            chunks = chunk_text(content)
            await self.chunk_repo.store(doc_id, self.user_id, "default", chunks)
        return row

    async def update_metadata(self, doc_id: str, fields: dict) -> dict | None:
        return await self.doc_repo.update_metadata(doc_id, self.user_id, **fields)

    async def delete(self, doc_id: str) -> bool:
        doc = await self.doc_repo.get(doc_id)
        if doc:
            fp = _doc_to_disk_path(doc)
            if fp and fp.is_file():
                mark_written(str(fp))
                fp.unlink()
        return await self.doc_repo.archive(doc_id, self.user_id)

    async def bulk_delete(self, doc_ids: list[str]) -> int:
        for did in doc_ids:
            doc = await self.doc_repo.get(did)
            if doc:
                fp = _doc_to_disk_path(doc)
                if fp and fp.is_file():
                    mark_written(str(fp))
                    fp.unlink()
        return await self.doc_repo.bulk_archive(doc_ids, self.user_id)


# ── Factory ──────────────────────────────────────────────────────────────────

class PgLocalServiceFactory(ServiceFactory):

    def __init__(self, pool, storage=None, user_id: str = ""):
        self.pool = pool
        self.storage = storage
        self.user_id = user_id

    def user_service(self, user_id: str) -> PgLocalUserService:
        return PgLocalUserService(self.pool, user_id)

    def kb_service(self, user_id: str) -> PgLocalKBService:
        return PgLocalKBService(self.pool, user_id)

    def document_service(self, user_id: str) -> PgLocalDocumentService:
        return PgLocalDocumentService(self.pool, user_id)
