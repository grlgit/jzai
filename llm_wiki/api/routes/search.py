from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from deps import get_user_id

router = APIRouter(tags=["search"])


def _resolve_scopes(request: Request) -> set[str] | None:
    """Return scopes from internal signed headers, or None for ADMIN_ALL."""
    internal_scopes = getattr(request.state, "internal_scopes", None)
    if internal_scopes is None:
        return None
    scopes = set(internal_scopes)
    if "ADMIN_ALL" in scopes:
        return None
    return scopes


@router.get("/v1/knowledge-bases/{kb_id}/search")
async def search_documents(
    kb_id: str,
    request: Request,
    user_id: Annotated[str, Depends(get_user_id)],
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    scope: str = Query("all"),
):
    """Full-text search across document chunks."""
    path_filter = None
    if scope == "wiki":
        path_filter = "wiki"
    elif scope == "sources":
        path_filter = "sources"

    scopes = _resolve_scopes(request)

    # PostgreSQL backend (unified DB with main platform)
    pool = request.app.state.pool
    if pool is not None:
        from vaultfs.pg_local import PgLocalVaultFS
        fs = PgLocalVaultFS(user_id)
        matches = await fs.search_chunks(
            str(kb_id), q, limit=limit,
            path_filter=path_filter, scopes=scopes,
        )
        return matches

    # SQLite backend
    db = request.app.state.sqlite_db
    if db is None:
        return []

    from infra.db.sqlite import SQLiteChunkRepository
    repo = SQLiteChunkRepository(db)
    results = await repo.search_fulltext(
        str(kb_id), q, limit=limit,
        path_filter=path_filter, user_id=user_id,
    )
    return results
