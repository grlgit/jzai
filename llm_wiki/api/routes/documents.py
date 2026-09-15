from typing import Annotated
from uuid import UUID  # noqa: F401 — kept for backward compat

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from deps import get_document_service, get_user_id
from services.base import DocumentService
from services.types import CreateNote, UpdateContent, UpdateMetadata, BulkDelete

router = APIRouter(tags=["documents"])


def _resolve_scopes(request: Request) -> set[str] | None:
    """Return scopes from internal signed headers, or None for ADMIN_ALL."""
    internal_scopes = getattr(request.state, "internal_scopes", None)
    if internal_scopes is None:
        return None
    scopes = set(internal_scopes)
    if "ADMIN_ALL" in scopes:
        return None
    return scopes


@router.get("/v1/knowledge-bases/{kb_id}/documents")
async def list_documents(
    kb_id: str,
    request: Request,
    service: Annotated[DocumentService, Depends(get_document_service)],
    path: str | None = Query(None),
):
    scopes = _resolve_scopes(request)
    return await service.list(str(kb_id), path, scopes=scopes)


@router.get("/v1/documents/{doc_id}")
async def get_document(
    doc_id: str,
    request: Request,
    service: Annotated[DocumentService, Depends(get_document_service)],
):
    row = await service.get(str(doc_id), scopes=_resolve_scopes(request))
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    return row


@router.get("/v1/documents/{doc_id}/url")
async def get_document_url(
    doc_id: str,
    request: Request,
    service: Annotated[DocumentService, Depends(get_document_service)],
):
    result = await service.get_url(str(doc_id), scopes=_resolve_scopes(request))
    if not result:
        raise HTTPException(status_code=404, detail="Document not found")
    return result


@router.get("/v1/documents/{doc_id}/content")
async def get_document_content(
    doc_id: str,
    request: Request,
    service: Annotated[DocumentService, Depends(get_document_service)],
):
    row = await service.get_content(str(doc_id), scopes=_resolve_scopes(request))
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    return row


@router.post("/v1/knowledge-bases/{kb_id}/documents/note", status_code=201)
async def create_note(
    kb_id: str,
    body: CreateNote,
    service: Annotated[DocumentService, Depends(get_document_service)],
):
    return await service.create_note(str(kb_id), body.filename, body.path, body.content)


@router.put("/v1/documents/{doc_id}/content")
async def update_document_content(
    doc_id: str,
    body: UpdateContent,
    service: Annotated[DocumentService, Depends(get_document_service)],
):
    row = await service.update_content(str(doc_id), body.content)
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    return row


@router.patch("/v1/documents/{doc_id}")
async def update_document_metadata(
    doc_id: str,
    body: UpdateMetadata,
    service: Annotated[DocumentService, Depends(get_document_service)],
):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    row = await service.update_metadata(str(doc_id), fields)
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    return row


@router.post("/v1/documents/bulk-delete", status_code=204)
async def bulk_delete_documents(
    body: BulkDelete,
    service: Annotated[DocumentService, Depends(get_document_service)],
):
    if not body.ids:
        return
    await service.bulk_delete(body.ids)


@router.delete("/v1/documents/{doc_id}", status_code=204)
async def delete_document(
    doc_id: str,
    service: Annotated[DocumentService, Depends(get_document_service)],
):
    if not await service.delete(str(doc_id)):
        raise HTTPException(status_code=404, detail="Document not found")


@router.get("/v1/documents/{doc_id}/extractions")
async def get_document_extractions(doc_id: str, request: Request):
    """Get knowledge extractions for a document (entities, facts, categories, summary)."""
    db = getattr(request.app.state, "sqlite_db", None)
    if db is None:
        raise HTTPException(status_code=501, detail="Extractions only available in local mode")

    from services.extractor import get_extractions
    results = await get_extractions(db, str(doc_id))
    return {"document_id": str(doc_id), "extractions": results}
