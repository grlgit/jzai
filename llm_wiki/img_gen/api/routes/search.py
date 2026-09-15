from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from deps import get_user_id

router = APIRouter(tags=["search"])


@router.get("/v1/knowledge-bases/{kb_id}/search")
async def search_documents(
    kb_id: UUID,
    request: Request,
    user_id: Annotated[str, Depends(get_user_id)],
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    scope: str = Query("all"),
):
    """Full-text search across document chunks."""
    db = request.app.state.sqlite_db
    if db is None:
        return []

    from infra.db.sqlite import SQLiteChunkRepository
    repo = SQLiteChunkRepository(db)

    path_filter = None
    if scope == "wiki":
        path_filter = "wiki"
    elif scope == "sources":
        path_filter = "sources"

    results = await repo.search_fulltext(
        str(kb_id), q, limit=limit,
        path_filter=path_filter, user_id=user_id,
    )
    return results
