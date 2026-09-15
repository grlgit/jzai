import logging
from pathlib import Path

from mcp.server.fastmcp import FastMCP, Context

from config import settings

logger = logging.getLogger(__name__)

CUSTOM_GUIDE_FILENAME = "GUIDE.md"

_LANGUAGE_NAMES = {
    "zh": "Chinese (中文)",
    "en": "English",
    "ja": "Japanese (日本語)",
    "ko": "Korean (한국어)",
    "es": "Spanish (Español)",
    "fr": "French (Français)",
    "de": "German (Deutsch)",
    "pt": "Portuguese (Português)",
    "ru": "Russian (Русский)",
    "ar": "Arabic (العربية)",
    "tr": "Turkish (Türkçe)",
}

LANGUAGE_INSTRUCTION = """
## Language Setting

**Target language: {lang_name} (`{lang_code}`)**

ALL wiki content you create or update MUST be written in **{lang_name}**. This applies to:
- Page titles and descriptions (in frontmatter)
- All body text, headings, summaries, and analysis
- Table headers and cell content
- Mermaid diagram labels and descriptions
- Log entries

**Do NOT translate:**
- Source filenames in citations (keep original filenames)
- Technical codes and identifiers (e.g., ST 201, W05)
- Proper nouns and brand names (e.g., LC Waikiki)
- Frontmatter field names (`title`, `description`, `date`, `tags`)

When ingesting a source document in any language, read and understand it in its original language, then write all wiki content in {lang_name}.
"""


def _load_custom_guide() -> str | None:
    try:
        from vaultfs.sqlite import _workspace_root
        if _workspace_root is None:
            return None
        guide_path = _workspace_root / CUSTOM_GUIDE_FILENAME
        if guide_path.is_file():
            content = guide_path.read_text(encoding="utf-8").strip()
            if content:
                logger.info("Loaded custom guide from %s", guide_path)
                return content
    except (ImportError, Exception) as e:
        logger.debug("Could not load custom guide: %s", e)
    return None


def _load_schema_config() -> dict | None:
    try:
        from local_server import _schema_config
        return _schema_config
    except (ImportError, AttributeError):
        return None


def _build_enterprise_section(schema: dict) -> str:
    lines: list[str] = []
    org = schema.get("organization", {})
    org_name = org.get("name", "")

    lines.append(f"## Enterprise Workspace: {org_name}\n")

    body = schema.get("_body", "")
    if body:
        lines.append(body)
        lines.append("")

    departments = schema.get("departments", {})
    if departments:
        lines.append("### Directory Structure & Access\n")
        for dept_name, dept_cfg in departments.items():
            slug = dept_cfg.get("slug", "")
            sub_attr = dept_cfg.get("subdirectory_attribute", "")
            sub_label = dept_cfg.get("subdirectory_label", "")
            members = dept_cfg.get("members", [])
            attr_hint = f" (subdirectories = {sub_label or sub_attr})" if sub_attr else ""
            lines.append(f"- **{dept_name}** (`/raw/{dept_name}/`){attr_hint} — {len(members)} members, slug: `{slug}`")
        lines.append("")

    workgroups = schema.get("workgroups", {})
    if workgroups:
        lines.append("### Cross-Department Workgroups\n")
        for wg_name, wg_cfg in workgroups.items():
            grants = wg_cfg.get("grant_access", [])
            paths = [g["path"] for g in grants]
            lines.append(f"- **{wg_name}** — access to: {', '.join(paths)}")
        lines.append("")

    wiki_cfg = schema.get("wiki", {})
    if wiki_cfg:
        if wiki_cfg.get("mirror_raw_structure"):
            lines.append("### Wiki Rules: `mirror_raw_structure: true` — Wiki paths MUST mirror `/raw/` hierarchy.\n")
        global_pages = wiki_cfg.get("global_pages", [])
        if global_pages:
            lines.append(f"Global wiki pages: {', '.join(global_pages)}\n")

    agent_cfg = schema.get("agent", {})
    if agent_cfg:
        lines.append("### Agent Behavior Rules\n")
        email_sources = agent_cfg.get("email_style_sources", [])
        if email_sources:
            lines.append("When composing emails, first read: " + ", ".join(f"`{s}`" for s in email_sources))
        priority = agent_cfg.get("customer_query_priority", [])
        if priority:
            lines.append("Customer query priority: " + " → ".join(f"`{p}`" for p in priority))
        lines.append("")

    return "\n".join(lines)


def register(mcp: FastMCP, get_user_id, fs_factory) -> None:

    @mcp.tool(
        name="guide",
        description="Get workspace configuration: available knowledge bases, enterprise schema, language setting, and taxonomy. Call this first to discover the KB slug needed for all other tool calls.",
    )
    async def guide(ctx: Context) -> str:
        user_id = get_user_id(ctx)
        fs = fs_factory(user_id)
        kbs = await fs.list_knowledge_bases()

        text = "# KB Workspace Configuration\n\n"

        schema = _load_schema_config()
        if schema:
            text += _build_enterprise_section(schema) + "\n"
        else:
            custom_guide = _load_custom_guide()
            if custom_guide:
                text += "## Workspace Custom Instructions\n\n" + custom_guide + "\n\n"

        lang_code = ""
        if schema:
            lang_code = schema.get("organization", {}).get("language", "").strip().lower()
        if not lang_code:
            lang_code = settings.WIKI_LANGUAGE.strip().lower()
        if lang_code:
            lang_name = _LANGUAGE_NAMES.get(lang_code, lang_code)
            text += LANGUAGE_INSTRUCTION.format(lang_name=lang_name, lang_code=lang_code)

        try:
            from .taxonomy import resolve_category_tree
            tree = resolve_category_tree()
            if tree:
                text += "\n## Knowledge Classification Tree\n\n```\n" + tree + "\n```\n\n"
        except Exception:
            pass

        if not kbs:
            return text + "\nNo knowledge bases yet."

        text += "## Available Knowledge Bases\n\n"
        for kb in kbs:
            slug = kb['slug']
            src_count = kb.get('source_count', '?')
            wiki_count = kb.get('wiki_count', '?')
            text += f"- **{kb['name']}** — slug: `{slug}` ({src_count} sources, {wiki_count} wiki pages)\n"

        if len(kbs) == 1:
            only_slug = kbs[0]['slug']
            text += f"\n> All tool calls MUST include `knowledge_base=\"{only_slug}\"`.\n"
        else:
            text += "\n> Every tool call MUST include `knowledge_base=\"<slug>\"` from the list above.\n"

        return text
