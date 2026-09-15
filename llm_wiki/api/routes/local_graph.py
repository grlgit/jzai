"""Local graph routes — thin HTTP layer, delegates to services/graph.py."""

from fastapi import APIRouter, Depends, Query, Request

from deps import get_user_id
from services.graph import get_graph_local, rebuild_local

router = APIRouter(tags=["graph"])


@router.get("/v1/knowledge-bases/{kb_id}/graph")
async def get_kb_graph(
    kb_id: str,
    user_id: str = Depends(get_user_id),
    request: Request = None,
):
    db = request.app.state.sqlite_db
    return await get_graph_local(db, user_id)


@router.post("/v1/knowledge-bases/{kb_id}/graph/rebuild")
async def rebuild_references(
    kb_id: str,
    user_id: str = Depends(get_user_id),
    request: Request = None,
):
    db = request.app.state.sqlite_db
    return await rebuild_local(db, user_id)


# ── Entity-level knowledge graph ────────────────────────────────────────────

@router.get("/v1/knowledge-bases/{kb_id}/graph/entities")
async def get_entity_graph_route(kb_id: str, request: Request = None):
    """Return entity-level knowledge graph (entities, relations, links to docs)."""
    db = request.app.state.sqlite_db
    from services.graph_builder import get_entity_graph
    return await get_entity_graph(db, kb_id)


@router.get("/v1/knowledge-bases/{kb_id}/graph/conflicts")
async def get_conflicts_route(
    kb_id: str,
    status: str = Query("open", regex="^(open|resolved|dismissed)$"),
    request: Request = None,
):
    """Return knowledge conflicts (duplicate facts, contradictions)."""
    db = request.app.state.sqlite_db
    from services.graph_builder import get_conflicts
    return await get_conflicts(db, status)


@router.post("/v1/knowledge-bases/{kb_id}/graph/conflicts/{conflict_id}/resolve")
async def resolve_conflict_route(
    kb_id: str, conflict_id: str,
    resolution: str = Query("resolved", regex="^(resolved|dismissed)$"),
    request: Request = None,
):
    """Resolve or dismiss a knowledge conflict."""
    db = request.app.state.sqlite_db
    from services.graph_builder import resolve_conflict
    ok = await resolve_conflict(db, conflict_id, resolution)
    return {"success": ok}
