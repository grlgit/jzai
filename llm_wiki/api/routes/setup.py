"""Setup wizard API routes.

Provides endpoints for initial system configuration:
- GET  /v1/setup/status   — check if setup is needed
- POST /v1/setup/save     — save SCHEMA.md and global config
- POST /v1/setup/restart  — trigger system restart
"""

import logging
import os
import signal
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/setup", tags=["setup"])

SCHEMA_SAMPLE_PATH = Path("/app/SCHEMA.md.sample")
RESTART_MARKER = Path("/tmp/.llmwiki-restart")


def _workspace_path(request: Request) -> Path:
    ws = getattr(request.app.state, "workspace_path", None)
    if ws:
        return Path(ws)
    return Path(os.environ.get("WORKSPACE_PATH", "/workspace"))


def _needs_setup(workspace: Path) -> dict:
    """Determine what setup steps are needed."""
    schema_path = workspace / "SCHEMA.md"
    db_path = workspace / ".llmwiki" / "index.db"
    init_marker = workspace / ".llmwiki" / ".setup-complete"

    return {
        "needs_setup": not init_marker.exists(),
        "has_database": db_path.exists(),
        "has_schema": schema_path.exists(),
        "workspace_path": str(workspace),
        "schema_sample_available": SCHEMA_SAMPLE_PATH.exists() or (Path(__file__).resolve().parent.parent.parent / "SCHEMA.md.sample").exists(),
    }


class SetupStatusResponse(BaseModel):
    needs_setup: bool
    has_database: bool
    has_schema: bool
    workspace_path: str
    schema_sample_available: bool


@router.get("/status", response_model=SetupStatusResponse)
async def get_setup_status(request: Request):
    workspace = _workspace_path(request)
    return _needs_setup(workspace)


class SchemaContent(BaseModel):
    content: str


@router.get("/schema-sample")
async def get_schema_sample():
    """Return the SCHEMA.md sample template."""
    # Try Docker path first, then relative path
    for candidate in [
        SCHEMA_SAMPLE_PATH,
        Path(__file__).resolve().parent.parent.parent / "SCHEMA.md.sample",
    ]:
        if candidate.exists():
            return {"content": candidate.read_text(encoding="utf-8")}
    return {"content": "# No sample template found.\n# Please create SCHEMA.md manually.\n"}


@router.get("/schema")
async def get_current_schema(request: Request):
    """Return the current SCHEMA.md content, or empty string if not exists."""
    schema_path = _workspace_path(request) / "SCHEMA.md"
    if schema_path.exists():
        return {"content": schema_path.read_text(encoding="utf-8")}
    return {"content": ""}


@router.post("/save")
async def save_setup(request: Request, body: SchemaContent):
    """Save SCHEMA.md and mark setup as complete."""
    workspace = _workspace_path(request)

    # Save SCHEMA.md
    schema_path = workspace / "SCHEMA.md"
    schema_path.write_text(body.content, encoding="utf-8")
    logger.info("SCHEMA.md saved to %s", schema_path)

    # Mark setup as complete
    marker = workspace / ".llmwiki" / ".setup-complete"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()

    return {"status": "ok", "message": "Configuration saved. Please restart to apply."}


@router.post("/skip")
async def skip_setup(request: Request):
    """Skip enterprise setup, run in personal mode."""
    workspace = _workspace_path(request)
    marker = workspace / ".llmwiki" / ".setup-complete"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()
    return {"status": "ok", "message": "Setup skipped. Running in personal mode."}


@router.post("/restart")
async def trigger_restart():
    """Signal the system to restart.

    In Docker, this sends SIGUSR1 to PID 1 (the entrypoint script),
    which triggers a graceful restart of all child processes.
    Falls back to SIGTERM if SIGUSR1 is not supported.
    """
    RESTART_MARKER.touch()
    logger.info("Restart requested — signaling entrypoint...")

    try:
        # Send signal to parent process (entrypoint)
        os.kill(1, signal.SIGUSR1)
    except (ProcessLookupError, PermissionError):
        try:
            ppid = os.getppid()
            os.kill(ppid, signal.SIGUSR1)
        except Exception as e:
            logger.warning("Could not signal parent for restart: %s", e)

    return {"status": "ok", "message": "Restart signal sent."}
