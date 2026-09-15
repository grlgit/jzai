"""Local MCP server — supports both stdio and HTTP transports.

One workspace = one MCP server. Filesystem is truth. SQLite is the index.

Usage (stdio — Claude Desktop / Claude Code / Cursor):
    python -m local_server --workspace ~/research

Usage (HTTP — standalone deployment):
    python -m local_server --workspace ~/research --http --port 8080
"""

import argparse
import asyncio
import logging
import os
import sys
import uuid
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("llmwiki.local")

_LOCAL_USER_ID = os.environ.get("LLMWIKI_USER_ID", str(uuid.uuid5(uuid.NAMESPACE_DNS, "local")))
os.environ["SUPAVAULT_USER_ID"] = _LOCAL_USER_ID


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LLM Wiki local MCP server")
    parser.add_argument("workspace", nargs="?", default=".", help="Path to workspace folder")
    parser.add_argument("--workspace", dest="workspace_flag", default=None, help="Path to workspace folder")
    parser.add_argument("--http", action="store_true", help="Run as HTTP server instead of stdio")
    parser.add_argument("--host", default="0.0.0.0", help="HTTP server bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8080, help="HTTP server port (default: 8080)")
    return parser.parse_args()


_schema_config: dict | None = None


async def _init_workspace(workspace_path: str) -> None:
    """Initialize workspace: create dirs, SQLite, default workspace row, scaffold wiki files."""
    global _schema_config
    ws = Path(workspace_path).resolve()

    (ws / "wiki").mkdir(parents=True, exist_ok=True)
    (ws / ".llmwiki").mkdir(parents=True, exist_ok=True)
    (ws / ".llmwiki" / "cache").mkdir(parents=True, exist_ok=True)

    from vaultfs import SqliteVaultFS
    await SqliteVaultFS.init(str(ws))

    fs = SqliteVaultFS(_LOCAL_USER_ID)
    existing = await fs.get_workspace()
    if not existing:
        ws_name = ws.name
        ws_id = await fs.ensure_workspace(ws_name)

        await fs.create_document(
            ws_id, "overview.md", "Overview", "/wiki/", "md",
            f"This wiki tracks research on {ws_name}.\n\n## Key Findings\n\nNo sources ingested yet.\n\n## Recent Updates\n\nNo activity yet.",
            ["overview"],
        )
        await fs.create_document(
            ws_id, "log.md", "Log", "/wiki/", "md",
            "Chronological record of ingests, queries, and maintenance passes.",
            ["log"],
        )

        overview_path = ws / "wiki" / "overview.md"
        if not overview_path.exists():
            overview_path.write_text(
                f"This wiki tracks research on {ws_name}.\n\n## Key Findings\n\n"
                "No sources ingested yet.\n\n## Recent Updates\n\nNo activity yet.\n"
            )
        log_path = ws / "wiki" / "log.md"
        if not log_path.exists():
            log_path.write_text("Chronological record of ingests, queries, and maintenance passes.\n")

        logger.info("Initialized workspace: %s", ws)
    else:
        logger.info("Workspace ready: %s", ws)

    # Enterprise init: parse SCHEMA.md and populate org/dept/permissions
    try:
        from schema_init import init_from_schema
        from vaultfs.sqlite import _db
        if _db is not None:
            _schema_config = await init_from_schema(_db, ws)
    except Exception as e:
        logger.warning("Enterprise init skipped: %s", e)


def main():
    args = _parse_args()
    workspace = args.workspace_flag or args.workspace
    workspace = str(Path(workspace).resolve())

    sys.modules["local_server"] = sys.modules[__name__]

    loop = asyncio.new_event_loop()
    loop.run_until_complete(_init_workspace(workspace))

    from mcp.server.fastmcp import FastMCP
    from tools import register
    from vaultfs import SqliteVaultFS

    from config import settings

    lang = settings.WIKI_LANGUAGE.strip().lower()
    lang_instruction = ""
    if lang:
        lang_instruction = f" IMPORTANT: All wiki content must be written in {lang}. Translate source content when writing wiki pages."

    mcp = FastMCP(
        name="LLM Wiki",
        json_response=True,
        stateless_http=True,
        instructions=(
            "You are connected to an LLM Wiki workspace — a structured knowledge base (知识库) "
            "containing company standards (公司标准), customer standards (客户标准), specifications (标准库), "
            "procedures, wiki pages, and reference documents. "
            "When the user mentions any of these topics — 知识库, 公司标准, 客户标准, 标准库, wiki, "
            "标准, 规范, 规程, 工艺标准, 质量标准, 检验标准, 技术文档, 参考资料, 标准文件, "
            "knowledge base, standards, specifications — use these tools to look up and manage that information. "
            "Call the `guide` tool first to see available knowledge bases and learn the full workflow."
            + lang_instruction
        ),
    )

    def _get_user_id(ctx):
        return _LOCAL_USER_ID

    register(mcp, _get_user_id, lambda user_id: SqliteVaultFS(user_id))

    @mcp.tool(name="ping", description="Test connectivity")
    async def ping() -> str:
        return "pong"

    logger.info("Local MCP server ready — workspace: %s", workspace)

    if args.http:
        import uvicorn
        from starlette.responses import PlainTextResponse
        from starlette.routing import Route

        async def health(request):
            return PlainTextResponse("OK")

        app = mcp.streamable_http_app()
        app.router.routes.insert(0, Route("/health", health))

        logger.info("Starting HTTP transport on %s:%d", args.host, args.port)
        uvicorn.run(app, host=args.host, port=args.port)
    else:
        asyncio.run(mcp.run_stdio_async())


if __name__ == "__main__":
    main()
