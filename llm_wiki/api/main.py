import asyncio
import hashlib
import hmac
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile
from starlette.middleware.cors import CORSMiddleware as _BaseCORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class CORSMiddleware(_BaseCORSMiddleware):
    """CORS middleware that passes WebSocket connections through.

    WebSocket auth is handled by JWT verification in the handler, not by
    origin checks. HTTP requests still get full CORS protection.
    """

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            await self.app(scope, receive, send)
            return
        await super().__call__(scope, receive, send)

from config import settings

logger = logging.getLogger(__name__)

if settings.SENTRY_DSN:
    import sentry_sdk
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        send_default_pii=True,
        traces_sample_rate=0.1,
        environment=settings.STAGE,
    )

if settings.LOGFIRE_TOKEN:
    import logfire
    logfire.configure(token=settings.LOGFIRE_TOKEN, service_name="supavault-api")
    logfire.instrument_asyncpg()

from routes.health import router as health_router
from routes.knowledge_bases import router as knowledge_bases_router
from routes.documents import router as documents_router
from routes.me import router as me_router
from routes.usage import router as usage_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.MODE == "local":
        async with _local_lifespan(app):
            yield
        return

    # ── Hosted mode ──
    import asyncpg
    pool = await asyncpg.create_pool(settings.DATABASE_URL, min_size=2, max_size=10)
    app.state.pool = pool
    app.state.mode = "hosted"

    s3_service = None
    ocr_service = None
    if settings.AWS_ACCESS_KEY_ID and settings.S3_BUCKET:
        from services.s3 import S3Service
        s3_service = S3Service()
    if s3_service:
        from services.ocr import OCRService
        ocr_service = OCRService(s3_service, pool)

    app.state.s3_service = s3_service
    app.state.ocr_service = ocr_service
    app.state.auth_provider = None  # Uses Supabase JWKS auth via deps.py

    from services.hosted import HostedServiceFactory
    app.state.factory = HostedServiceFactory(pool, s3_service, ocr_service)

    # Real-time document change notifications via WebSocket
    from routes.ws import setup_listener
    listener_task = await setup_listener(settings.DATABASE_URL)

    from infra.tus import cleanup_stale_uploads
    cleanup_task = asyncio.create_task(cleanup_stale_uploads())

    if ocr_service:
        rows = await pool.fetch(
            "SELECT id::text, user_id::text FROM documents "
            "WHERE status IN ('pending', 'processing') AND NOT archived"
        )
        for row in rows:
            logger.info("Recovering stuck document %s", row["id"][:8])
            asyncio.create_task(ocr_service.process_document(row["id"], row["user_id"]))

    yield

    cleanup_task.cancel()
    listener_task.cancel()
    await pool.close()


async def _local_lifespan_inner(app: FastAPI):
    """Local mode: SQLite + local filesystem + single-user auth."""
    import uuid
    from pathlib import Path
    from infra.db.sqlite import create_pool as create_sqlite_pool
    from infra.storage.local import LocalStorageService
    from infra.auth.local import LocalAuthProvider

    workspace = Path(settings.WORKSPACE_PATH).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "wiki").mkdir(exist_ok=True)
    (workspace / ".llmwiki").mkdir(exist_ok=True)
    (workspace / ".llmwiki" / "cache").mkdir(exist_ok=True)

    db_path = str(workspace / ".llmwiki" / "index.db")
    db = await create_sqlite_pool(db_path)

    local_user_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, "local"))
    auth_provider = LocalAuthProvider(local_user_id)
    storage = LocalStorageService(str(workspace), settings.API_URL)

    # Ensure workspace row exists
    cursor = await db.execute("SELECT id FROM workspace LIMIT 1")
    if not await cursor.fetchone():
        ws_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO workspace (id, name, description, user_id) VALUES (?, ?, '', ?)",
            (ws_id, workspace.name, local_user_id),
        )
        await db.commit()
        logger.info("Initialized local workspace: %s", workspace)

    app.state.mode = "local"
    app.state.pool = None  # No asyncpg pool in local mode
    app.state.sqlite_db = db
    app.state.s3_service = None
    app.state.storage_service = storage
    app.state.ocr_service = None
    app.state.auth_provider = auth_provider
    app.state.workspace_path = str(workspace)

    from services.local import LocalServiceFactory
    app.state.factory = LocalServiceFactory(db, storage, local_user_id)

    logger.info("Local mode — workspace: %s", workspace)
    return db


@asynccontextmanager
async def _pg_local_lifespan(app: FastAPI):
    """Local mode with PostgreSQL backend (unified DB with main platform)."""
    import uuid
    from pathlib import Path
    import asyncpg
    from infra.storage.local import LocalStorageService
    from infra.auth.local import LocalAuthProvider

    workspace = Path(settings.WORKSPACE_PATH).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "raw").mkdir(exist_ok=True)
    (workspace / "wiki").mkdir(exist_ok=True)
    (workspace / "personal").mkdir(exist_ok=True)
    (workspace / ".llmwiki").mkdir(exist_ok=True)
    (workspace / ".llmwiki" / "cache").mkdir(exist_ok=True)

    pool = await asyncpg.create_pool(settings.KB_DATABASE_URL, min_size=2, max_size=10)
    local_user_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, "local"))
    auth_provider = LocalAuthProvider(local_user_id)
    storage = LocalStorageService(str(workspace), settings.API_URL)

    app.state.mode = "pg_local"
    app.state.pool = pool
    app.state.sqlite_db = None
    app.state.s3_service = None
    app.state.storage_service = storage
    app.state.ocr_service = None
    app.state.auth_provider = auth_provider
    app.state.workspace_path = str(workspace)

    from services.pg_local import PgLocalServiceFactory
    app.state.factory = PgLocalServiceFactory(pool, storage, local_user_id)

    logger.info("PG Local mode — workspace: %s, db: %s", workspace, settings.KB_DATABASE_URL.split("@")[-1] if "@" in settings.KB_DATABASE_URL else "***")

    try:
        yield
    finally:
        await pool.close()


@asynccontextmanager
async def _local_lifespan(app: FastAPI):
    # If KB_DATABASE_URL is set, use PostgreSQL instead of SQLite
    if settings.KB_DATABASE_URL:
        async with _pg_local_lifespan(app):
            yield
        return

    db = await _local_lifespan_inner(app)

    # Start file watcher
    watcher_task = None
    try:
        from domain.watcher import watch_workspace
        from pathlib import Path
        workspace = Path(app.state.workspace_path)
        watcher_task = asyncio.create_task(watch_workspace(db, workspace))
        logger.info("File watcher started")
    except ImportError:
        logger.warning("watchfiles not installed — file watcher disabled")

    try:
        yield
    finally:
        if watcher_task:
            watcher_task.cancel()
            try:
                await watcher_task
            except asyncio.CancelledError:
                pass
        await db.close()


app = FastAPI(title="LLM Wiki API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.APP_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "Location", "Upload-Offset", "Upload-Length",
        "Tus-Resumable", "Tus-Version", "Tus-Max-Size", "Tus-Extension",
        "X-Document-Id",
    ],
)

if settings.LOGFIRE_TOKEN:
    import logfire
    logfire.instrument_fastapi(app)


# ── Internal request signature verification (signed REST proxy from main platform) ──

_INTERNAL_HEADER_TTL_SECONDS = 300


async def _set_body(request: Request, body: bytes) -> None:
    """Restore request body stream after reading it for signature verification."""
    async def receive() -> dict:
        return {"type": "http.request", "body": body}

    request._receive = receive  # type: ignore[attr-defined]


@app.middleware("http")
async def internal_signature_middleware(request: Request, call_next):
    """Verify X-JZ-* HMAC headers and expose trusted user/scopes on request.state."""
    user = request.headers.get("x-jz-user")
    scopes_header = request.headers.get("x-jz-scopes")
    signature = request.headers.get("x-jz-signature")
    timestamp = request.headers.get("x-jz-timestamp")

    if not user and not scopes_header and not signature and not timestamp:
        # No internal headers present — leave authentication to normal JWT/local auth.
        return await call_next(request)

    if not (user and scopes_header and signature and timestamp):
        return JSONResponse(
            status_code=401,
            content={"detail": "Incomplete internal authentication headers"},
        )

    try:
        ts = int(timestamp)
    except ValueError:
        return JSONResponse(
            status_code=401,
            content={"detail": "Invalid internal authentication timestamp"},
        )

    if abs(int(time.time()) - ts) > _INTERNAL_HEADER_TTL_SECONDS:
        return JSONResponse(
            status_code=401,
            content={"detail": "Internal authentication timestamp expired"},
        )

    secret = settings.KB_INTERNAL_SECRET
    if not secret:
        return JSONResponse(
            status_code=401,
            content={"detail": "Internal authentication not configured"},
        )

    body = await request.body()
    await _set_body(request, body)
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = (
        f"{request.method.upper()}\n"
        f"{request.url.path}\n"
        f"{timestamp}\n"
        f"{scopes_header}\n"
        f"{body_hash}"
    )
    expected = hmac.new(
        secret.encode("utf-8"),
        canonical.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        return JSONResponse(
            status_code=401,
            content={"detail": "Invalid internal authentication signature"},
        )

    request.state.internal_user = user
    request.state.internal_scopes = [
        s.strip() for s in scopes_header.split(",") if s.strip()
    ]
    return await call_next(request)


from routes.setup import router as setup_router
app.include_router(setup_router)
app.include_router(health_router)
app.include_router(me_router)
app.include_router(usage_router)
app.include_router(knowledge_bases_router)
app.include_router(documents_router)

# ── Version & Upgrade endpoints (all modes) ──
import json
from pathlib import Path as _Path

@app.get("/version")
async def get_version():
    """Return current KB version."""
    for p in [_Path(__file__).parent / "version.json", _Path.cwd() / "version.json"]:
        if p.exists():
            return json.loads(p.read_text())
    return {"version": "unknown", "component": "kb"}

@app.post("/upgrade")
async def upgrade_kb(file: UploadFile):
    """Receive upgrade tar.gz and replace KB files. Internal use only."""
    import tarfile, shutil, signal, os, tempfile

    tmp_dir = tempfile.mkdtemp(prefix="kb-upgrade-")
    tar_path = _Path(tmp_dir) / "kb.tar.gz"

    try:
        # Save uploaded file
        content = await file.read()
        tar_path.write_bytes(content)
        logger.info(f"[Upgrade] Received {len(content)} bytes")

        # Extract
        with tarfile.open(str(tar_path), "r:gz") as tar:
            tar.extractall(tmp_dir)

        # Find the kb directory in extracted content
        kb_src = _Path(tmp_dir) / "kb"
        if not kb_src.exists():
            # Maybe it's extracted directly without kb/ prefix
            candidates = [d for d in _Path(tmp_dir).iterdir() if d.is_dir() and d.name != "__MACOSX"]
            kb_src = candidates[0] if candidates else _Path(tmp_dir)

        # Backup current files
        app_dir = _Path("/app")
        for sub in ["api", "mcp", "shared"]:
            src = app_dir / sub
            bak = app_dir / f"{sub}.bak"
            if src.exists():
                if bak.exists():
                    shutil.rmtree(str(bak))
                shutil.copytree(str(src), str(bak))

        # Copy new files
        for sub in ["api", "mcp", "shared"]:
            new_src = kb_src / sub
            if new_src.exists():
                target = app_dir / sub
                # Preserve venv and __pycache__
                for item in new_src.iterdir():
                    dest = target / item.name
                    if item.name in (".venv", "__pycache__", ".llmwiki"):
                        continue
                    if item.is_dir():
                        if dest.exists():
                            shutil.rmtree(str(dest))
                        shutil.copytree(str(item), str(dest))
                    else:
                        shutil.copy2(str(item), str(dest))

        # Copy version.json if present
        ver_src = kb_src / "version.json"
        if ver_src.exists():
            shutil.copy2(str(ver_src), str(app_dir / "api" / "version.json"))
            shutil.copy2(str(ver_src), str(app_dir / "version.json"))

        # Clean backup
        for sub in ["api", "mcp", "shared"]:
            bak = app_dir / f"{sub}.bak"
            if bak.exists():
                shutil.rmtree(str(bak))

        logger.info("[Upgrade] KB files replaced successfully")

        # Schedule restart (SIGTERM to self → entrypoint will restart)
        # Delay to allow response to be sent
        import threading
        def delayed_exit():
            import time; time.sleep(2)
            logger.info("[Upgrade] Restarting KB...")
            os.kill(os.getpid(), signal.SIGTERM)
        threading.Thread(target=delayed_exit, daemon=True).start()

        return {"status": "ok", "message": "KB upgraded, restarting..."}
    except Exception as e:
        logger.error(f"[Upgrade] Failed: {e}")
        # Rollback
        app_dir = _Path("/app")
        for sub in ["api", "mcp", "shared"]:
            bak = app_dir / f"{sub}.bak"
            target = app_dir / sub
            if bak.exists():
                if target.exists():
                    shutil.rmtree(str(target))
                shutil.move(str(bak), str(target))
        return {"status": "error", "message": str(e)}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if settings.MODE == "local":
    from routes.local_upload import router as local_upload_router
    from routes.files import router as files_router, set_workspace_root
    from routes.local_graph import router as local_graph_router
    from routes.search import router as search_router
    from routes.permissions import router as permissions_router
    app.include_router(local_upload_router)
    app.include_router(files_router)
    app.include_router(local_graph_router)
    app.include_router(search_router)
    app.include_router(permissions_router)
    set_workspace_root(settings.WORKSPACE_PATH)
else:
    from routes.api_keys import router as api_keys_router
    from routes.admin import router as admin_router
    from routes.graph import router as graph_router
    from routes.ws import router as ws_router
    from infra.tus import router as tus_router
    app.include_router(api_keys_router)
    app.include_router(admin_router)
    app.include_router(tus_router)
    app.include_router(graph_router)
    app.include_router(ws_router)
