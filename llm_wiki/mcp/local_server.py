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


_CHARACTER_SEED = """\
---
title: 企业文化
description: 企业使命、愿景与核心价值观
tags:
  - character
  - culture
---

# 企业文化

## 使命
[请填写企业使命，例如：为客户创造价值，为员工搭建平台]

## 愿景
[请填写企业愿景，例如：成为行业标杆，引领创新发展]

## 核心价值观
- 诚信：以诚待人，言出必行
- 创新：拥抱变化，持续改进
- 协作：开放共享，团队至上
- 卓越：追求品质，精益求精

## 文化理念
[请填写企业的文化理念，例如：客户第一、拥抱变化、团队合作、诚信、激情、敬业]
"""

_RULES_SEED = """\
---
title: 行为准则
description: AI助手的通用操作规则和安全边界
tags:
  - rules
  - general
---

# 行为准则

## 回答规范
1. 引用企业心智内容时标注来源文档
2. 涉及数字、日期、规格等关键信息务必核实
3. 不确定的内容明确标注"待确认"
4. 多条信息时使用结构化格式（列表、表格）

## 安全边界
1. 不透露内部系统架构或配置细节
2. 不代替人工做最终审批决策
3. 涉及合同、法律、财务问题建议咨询专业人员
4. 不对外部人员披露企业内部信息
"""


async def _seed_enterprise_mind(ws: Path, fs) -> None:
    """Ensure _character/ and _rules/ directories and seed content exist.
    Safe to call on both new and existing workspaces."""
    workspace = await fs.get_workspace()
    if not workspace:
        return
    ws_id = str(workspace["id"])

    seeds = [
        ("_character", "identity.md", "企业文化", _CHARACTER_SEED, ["character", "identity"]),
        ("_rules", "general.md", "行为准则", _RULES_SEED, ["rules", "general"]),
    ]

    for dir_name, filename, title, content, tags in seeds:
        dir_path = ws / "wiki" / dir_name
        dir_path.mkdir(parents=True, exist_ok=True)

        file_path = dir_path / filename
        if not file_path.exists():
            file_path.write_text(content, encoding="utf-8")
            logger.info("Created seed file: wiki/%s/%s", dir_name, filename)

        # Ensure document record exists in VaultFS
        existing_doc = await fs.get_document(ws_id, filename, f"/wiki/{dir_name}/")
        if not existing_doc:
            await fs.create_document(
                ws_id, filename, title, f"/wiki/{dir_name}/", "md",
                content, tags,
            )
            logger.info("Created VaultFS record: /wiki/%s/%s", dir_name, filename)


async def _init_workspace(workspace_path: str) -> None:
    """Initialize workspace: create dirs, SQLite, default workspace row, scaffold wiki files."""
    global _schema_config
    ws = Path(workspace_path).resolve()

    (ws / "wiki").mkdir(parents=True, exist_ok=True)
    (ws / ".llmwiki").mkdir(parents=True, exist_ok=True)
    (ws / ".llmwiki" / "cache").mkdir(parents=True, exist_ok=True)

    from config import settings
    use_pg = bool(settings.KB_DATABASE_URL)

    if use_pg:
        from vaultfs.pg_local import PgLocalVaultFS
        # Only store config — pool will be created in uvicorn's event loop via startup event
        PgLocalVaultFS._database_url = settings.KB_DATABASE_URL
        from pathlib import Path as _P
        import vaultfs.pg_local as _pgmod
        _pgmod._workspace_root = _P(str(ws)).resolve()
        fs = None  # Skip DB operations during init (pool not available yet)
    else:
        from vaultfs import SqliteVaultFS
        await SqliteVaultFS.init(str(ws))
        fs = SqliteVaultFS(_LOCAL_USER_ID)
    existing = await fs.get_workspace() if fs else True  # PG mode: skip init queries
    if not existing:
        ws_name = ws.name
        ws_id = await fs.ensure_workspace(ws_name)
        # No global overview.md/log.md — these are created per-category by the wiki compiler

        logger.info("Initialized workspace: %s", ws)
    else:
        logger.info("Workspace ready: %s", ws)

    # ── Enterprise Mind: seed _character/ and _rules/ if missing ─────
    if fs:
        await _seed_enterprise_mind(ws, fs)

    # Enterprise init: parse SCHEMA.md and populate org/dept/permissions
    try:
        from schema_init import init_from_schema
        from vaultfs.sqlite import _db
        if _db is not None:
            _schema_config = await init_from_schema(_db, ws)
    except Exception as e:
        logger.warning("Enterprise init skipped: %s", e)

    # Load taxonomy for synonym expansion
    try:
        from tools.taxonomy import load_taxonomy
        load_taxonomy(ws)
    except Exception as e:
        logger.debug("Taxonomy loading skipped: %s", e)

    # PG mode: destroy init-loop pool so _get_pool() will create fresh one in uvicorn's loop
    if use_pg:
        import vaultfs.pg_local as _pgmod
        if _pgmod._pool is not None:
            try: await _pgmod._pool.close()
            except: pass
            _pgmod._pool = None
            logger.info("Init pool destroyed (will recreate lazily in server loop)")


def main():
    args = _parse_args()
    workspace = args.workspace_flag or args.workspace
    workspace = str(Path(workspace).resolve())

    sys.modules["local_server"] = sys.modules[__name__]

    from config import settings
    use_pg = bool(settings.KB_DATABASE_URL)

    if not use_pg:
        # SQLite mode: init synchronously (safe — no uvicorn event loop conflict)
        loop = asyncio.new_event_loop()
        loop.run_until_complete(_init_workspace(workspace))
    else:
        # PG mode: only create dirs, skip DB ops (pool will init in uvicorn's loop)
        ws = Path(workspace).resolve()
        (ws / "raw").mkdir(parents=True, exist_ok=True)
        (ws / "wiki").mkdir(parents=True, exist_ok=True)
        (ws / "personal").mkdir(parents=True, exist_ok=True)
        (ws / ".llmwiki").mkdir(parents=True, exist_ok=True)
        (ws / ".llmwiki" / "cache").mkdir(parents=True, exist_ok=True)
        from vaultfs.pg_local import PgLocalVaultFS
        PgLocalVaultFS._database_url = settings.KB_DATABASE_URL
        import vaultfs.pg_local as _pgmod
        _pgmod._workspace_root = ws
        logger.info("PG mode: dirs ready, pool will init lazily in server loop")

    from mcp.server.fastmcp import FastMCP
    from tools import register
    if use_pg:
        from vaultfs.pg_local import PgLocalVaultFS
        # Pool will be lazily created in uvicorn's event loop on first tool call
        logger.info("MCP using PostgreSQL VaultFS (lazy pool)")
    else:
        from vaultfs import SqliteVaultFS
        logger.info("MCP using SQLite VaultFS")

    lang = settings.WIKI_LANGUAGE.strip().lower()
    lang_instruction = ""
    if lang:
        lang_instruction = f" IMPORTANT: All wiki content must be written in {lang}. Translate source content when writing wiki pages."

    mcp = FastMCP(
        name="LLM Wiki",
        json_response=True,
        stateless_http=True,
        host="0.0.0.0",  # Accept requests from Docker internal hostnames (kb:3011)
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

    def _fs_factory(user_id):
        if use_pg:
            return PgLocalVaultFS(user_id)
        return SqliteVaultFS(user_id)

    register(mcp, _get_user_id, _fs_factory)

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

        # PG pool is lazily created on first tool call in uvicorn's event loop

        logger.info("Starting HTTP transport on %s:%d", args.host, args.port)
        uvicorn.run(app, host=args.host, port=args.port)
    else:
        asyncio.run(mcp.run_stdio_async())


if __name__ == "__main__":
    main()
