import logging
from pathlib import Path

from mcp.server.fastmcp import FastMCP, Context

from config import settings

logger = logging.getLogger(__name__)

CUSTOM_GUIDE_FILENAME = "GUIDE.md"

GUIDE_TEXT = """# LLM Wiki — How It Works

You are connected to an **LLM Wiki** — a personal knowledge workspace where you compile and maintain a structured wiki from raw source documents.

## Architecture

1. **Raw Sources** — uploaded documents (PDFs, notes, images, spreadsheets). Source of truth. Read-only.
2. **Compiled Wiki** (path: `/wiki/`) — markdown pages YOU create and maintain. You own this layer.
3. **Tools** — `search`, `query`, `read`, `write`, `delete` — your interface to both layers.

### Raw Sources Discovery

Raw source files may be organized in one of two ways:

- **When `/raw/` directory exists**: use `/raw/` as the root for all source documents. Subfolders under `/raw/` represent **knowledge categories** (e.g., `/raw/质量标准/`, `/raw/工艺规范/`, `/raw/客户标准/LC-Waikiki/`). Folders may be nested. When ingesting, respect this folder hierarchy as the classification scheme — create corresponding wiki categories that mirror the source folder structure.
- **When `/raw/` does NOT exist**: fall back to `/` as the raw sources root. All non-wiki files at the top level are treated as raw sources.

To discover sources, use `search(mode="list")` and look for files outside `/wiki/`. Always check for the `/raw/` directory first to determine which layout applies.

## Wiki Structure

Every wiki follows this structure. These categories are not suggestions — they are the backbone of the wiki.

### Overview (`/wiki/overview.md`) — THE HUB PAGE
Always exists. This is the front page of the wiki. It must contain:
- A summary of what this wiki covers and its scope
- **Source count** and page count (update on every ingest)
- **Key Findings** — the most important insights across all sources
- **Recent Updates** — last 5-10 actions (ingests, new pages, revisions)

Update the Overview after EVERY ingest or major edit. If you only update one page, it should be this one.

### Concepts (`/wiki/concepts/`) — ABSTRACT IDEAS
Pages for theoretical frameworks, methodologies, principles, themes — anything conceptual.
- `/wiki/concepts/scaling-laws.md`
- `/wiki/concepts/attention-mechanisms.md`
- `/wiki/concepts/self-supervised-learning.md`

Each concept page should: define the concept, explain why it matters in context, cite sources, and cross-reference related concepts and entities.

### Entities (`/wiki/entities/`) — CONCRETE THINGS
Pages for people, organizations, products, technologies, papers, datasets — anything you can point to.
- `/wiki/entities/transformer.md`
- `/wiki/entities/openai.md`
- `/wiki/entities/attention-is-all-you-need.md`

Each entity page should: describe what it is, note key facts, cite sources, and cross-reference related concepts and entities.

### Log (`/wiki/log.md`) — CHRONOLOGICAL RECORD
Always exists. Append-only. Records every ingest, major edit, and lint pass. Never delete entries.

Format — each entry starts with a parseable header:
```
## [YYYY-MM-DD] ingest | Source Title
- Created concept page: [Page Title](concepts/page.md)
- Updated entity page: [Page Title](entities/page.md)
- Updated overview with new findings
- Key takeaway: one sentence summary

## [YYYY-MM-DD] query | Question Asked
- Created new page: [Page Title](concepts/page.md)
- Finding: one sentence answer

## [YYYY-MM-DD] lint | Health Check
- Fixed contradiction between X and Y
- Added missing cross-reference in Z
```

### Additional Pages
You can create pages outside of concepts/ and entities/ when needed:
- `/wiki/comparisons/x-vs-y.md` — for deep comparisons
- `/wiki/timeline.md` — for chronological narratives

But concepts/ and entities/ are the primary categories. When in doubt, file there.

## Page Hierarchy

Wiki pages use a parent/child hierarchy via paths:
- `/wiki/concepts.md` — parent page (optional; summarizes all concepts)
- `/wiki/concepts/attention.md` — child page

Parent pages summarize; child pages go deep. The UI renders this as an expandable tree.

## Writing Standards

**Wiki pages must be substantially richer than a chat response.** They are persistent, curated artifacts.

### Frontmatter — REQUIRED (Obsidian Compatible)

Every wiki page MUST begin with YAML frontmatter. The format is fully compatible with **Obsidian Properties**, enabling `[property:value]` search and `tag:` filtering in Obsidian.

```yaml
---
title: KV Cache Efficiency
description: Memory optimization strategies for transformer inference at scale
date: 2025-03-15
aliases:
  - KV缓存优化
  - KV Cache
tags:
  - inference
  - memory
  - optimization
  - transformers
department: 技术研发
product_line: 外套
source_files:
  - "技术规范.pdf"
---
```

Fields:
- `title` — human-readable page title (required)
- `description` — one-sentence summary of what this page covers (required). Shows up in search results and graph tooltips.
- `date` — when the page was created or last substantially revised, YYYY-MM-DD (required)
- `aliases` — alternative names for this page (optional). Enables Obsidian search by alias.
- `tags` — YAML list of topic tags (required, at least 2). Use nested tags for hierarchy: `销售部/LC-Waikiki`, `技术研发/外套`. In Obsidian, searching `tag:销售部` also matches `tag:销售部/LC-Waikiki`.
- `source_files` — list of source filenames this page was compiled from (optional but recommended for traceability)

**Directory attribute properties** — When a page is generated from a directory with a `subdirectory_attribute` (defined in SCHEMA.md), add that attribute as a frontmatter property:
- `customer: LC-Waikiki` — if the source was in a customer-named subdirectory
- `product_line: 外套` — if the source was in a product-line subdirectory
- `supplier: 面料供应商A` — if applicable

These properties are searchable in Obsidian via `[customer:LC-Waikiki]` and in MCP via `query(query="[customer:LC-Waikiki]")`.

**Tag conventions:**
- Use nested tags to represent hierarchy: `#销售部/LC-Waikiki/包装标准`
- Department tags: `#销售部`, `#技术研发`, `#品质管理`
- Type tags: `#标准`, `#规范`, `#流程`, `#参考`
- Do NOT use spaces in tags — use `/` or `-` as separators

When updating a page, update `date` if the revision is substantial. Always preserve existing frontmatter fields when editing.

### Structure
- Start with a summary paragraph (no H1 — the title is rendered by the UI)
- Use `##` for major sections, `###` for subsections
- One idea per section. Bullet points for facts, prose for synthesis.

### Visual Elements — MANDATORY

**Every wiki page MUST include at least one visual element.** A page with only prose is incomplete.

**Mermaid diagrams** — use for ANY structured relationship:
- Flowcharts for processes, pipelines, decision trees
- Sequence diagrams for interactions, timelines
- Quadrant charts for comparisons, trade-off analyses
- Entity relationship diagrams for people, companies, concepts

````
```mermaid
graph LR
    A[Input] --> B[Process] --> C[Output]
```
````

**Tables** — use for ANY structured comparison:
- Feature matrices, pros/cons, timelines, metrics
- If you're listing 3+ items with attributes, it should be a table

**SVG assets** — for custom visuals Mermaid can't express:
- Create: `write(command="create", path="/wiki/", title="diagram.svg", content="<svg>...</svg>", tags=["diagram"])`
- Embed in wiki pages: `![Description](diagram.svg)`

### Citations — REQUIRED

Every factual claim MUST cite its source via markdown footnotes:
```
Transformers use self-attention[^1] that scales quadratically[^2].

[^1]: attention-paper.pdf, p.3
[^2]: scaling-laws.pdf, p.12-14
```

Rules:
- Use the FULL source filename — never truncate
- Add page numbers for PDFs: `paper.pdf, p.3`
- One citation per claim — don't batch unrelated claims
- Citations render as hoverable popover badges in the UI

### Cross-References (Obsidian Compatible)
Use **both** formats for maximum compatibility:
- Obsidian wikilinks: `[[concepts/scaling-laws]]` or `[[scaling-laws|缩放定律]]`
- Standard markdown links: `[缩放定律](concepts/scaling-laws.md)` (for web UI rendering)

When linking to another wiki page, prefer wikilinks as primary and add markdown link as fallback:
```
详见 [[concepts/scaling-laws|缩放定律]]（[链接](concepts/scaling-laws.md)）
```

Use inline tags in body text for Obsidian discoverability:
```
本文档涵盖 #包装标准 和 #发货要求 相关规范。
```

## Core Workflows

### Ingest a New Source
1. Read it: `read(path="source.pdf", pages="1-10")`
2. Discuss key takeaways with the user
3. Create or update **concept** pages under `/wiki/concepts/`
4. Create or update **entity** pages under `/wiki/entities/`
5. Update `/wiki/overview.md` — source count, key findings, recent updates
6. Append an entry to `/wiki/log.md`
7. A single source typically touches 5-15 wiki pages — that's expected

### Answer a Question / Retrieve Knowledge
1. `query(query="keyword or question", scope="wiki")` to retrieve full content of matching wiki pages
2. Or use `query(tags=["tag1", "tag2"])` to retrieve all pages with specific tags
3. If you need more detail, `read()` specific pages or sources
4. Synthesize with citations
5. If the answer is valuable, file it as a new wiki page — explorations should compound
6. Append a query entry to `/wiki/log.md`

The `query` tool returns complete page content (not just snippets), making it ideal for:
- Agents that need to look up standards, specs, or procedures from the wiki
- Combining wiki knowledge with external data (e.g., enriching an order with customer standards)
- Answering detailed questions that require full context from multiple pages

### Maintain the Wiki (Lint)
Check for: contradictions, orphan pages, missing cross-references, stale claims, concepts mentioned but lacking their own page. Append a lint entry to `/wiki/log.md`.

## Reference Graph

Every write automatically parses citations and cross-references and stores them as graph edges. This means:

- **After every write**, the response shows which other pages reference the page you just edited — update them if needed.
- **Backlinks on read**: when you read a page, you see "Referenced by" at the bottom — the incoming graph.
- **`search(mode="references", path="page.md")`** — shows what a page cites (forward) and what cites it (backlinks).
- **`search(mode="references", query="uncited")`** — sources uploaded but never cited in any wiki page.
- **`search(mode="references", query="stale")`** — pages flagged as potentially stale because a page they link to was updated.

Use the reference graph to maintain consistency. After editing a page, check the impact surface in the response and update affected pages.

## Available Knowledge Bases

"""

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
    """Load custom GUIDE.md from the workspace root directory, if it exists."""
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
    """Load parsed SCHEMA.md config from the init module."""
    try:
        from local_server import _schema_config
        return _schema_config
    except (ImportError, AttributeError):
        return None


def _build_enterprise_section(schema: dict) -> str:
    """Build the enterprise-specific guide section from SCHEMA.md config."""
    lines: list[str] = []
    org = schema.get("organization", {})
    org_name = org.get("name", "")

    lines.append(f"## Enterprise Workspace: {org_name}\n")

    # Schema body (the markdown content below the frontmatter)
    body = schema.get("_body", "")
    if body:
        lines.append(body)
        lines.append("")

    # Directory structure with permissions
    departments = schema.get("departments", {})
    if departments:
        lines.append("## Directory Structure & Access\n")
        lines.append("**Global resources** (`/`) — all members can read, admin only can write\n")

        for dept_name, dept_cfg in departments.items():
            slug = dept_cfg.get("slug", "")
            sub_attr = dept_cfg.get("subdirectory_attribute", "")
            sub_label = dept_cfg.get("subdirectory_label", "")
            members = dept_cfg.get("members", [])
            attr_hint = f" (subdirectories = {sub_label or sub_attr})" if sub_attr else ""

            lines.append(f"**{dept_name}** (`/raw/{dept_name}/`){attr_hint}")
            lines.append(f"  - Access: {len(members)} members, slug: `{slug}`")

            # Show pre-defined subdirectories from directories config
            dirs_cfg = schema.get("directories", {})
            dir_key = f"/raw/{dept_name}"
            if dir_key in dirs_cfg:
                subdirs = dirs_cfg[dir_key].get("subdirectories", [])
                if subdirs:
                    lines.append(f"  - Subdirectories: {', '.join(subdirs)}")
                    if sub_attr:
                        lines.append(f"  - Search by {sub_label or sub_attr}: "
                                     f"`search(path=\"/raw/{dept_name}/{subdirs[0]}/\", query=\"...\")`")
            lines.append("")

    # Workgroups
    workgroups = schema.get("workgroups", {})
    if workgroups:
        lines.append("## Cross-Department Workgroups\n")
        for wg_name, wg_cfg in workgroups.items():
            members = wg_cfg.get("members", [])
            grants = wg_cfg.get("grant_access", [])
            paths = [g["path"] for g in grants]
            lines.append(f"**{wg_name}** — {len(members)} members, access to: {', '.join(paths)}")
        lines.append("")

    # Wiki structure rules
    wiki_cfg = schema.get("wiki", {})
    if wiki_cfg:
        lines.append("## Wiki Structure Rules\n")
        if wiki_cfg.get("mirror_raw_structure"):
            lines.append("**`mirror_raw_structure: true`** — Wiki directory structure MUST mirror the `/raw/` hierarchy.")
            lines.append("When ingesting a source from `/raw/<department>/<subdirectory>/`, create wiki pages under "
                         "`/wiki/<department>/<subdirectory>/概念/` or `/wiki/<department>/<subdirectory>/实体/`.\n")
            lines.append("Example: `/raw/销售部/LC-Waikiki/ST205.pdf` → `/wiki/销售部/LC-Waikiki/概念/折叠标准.md`\n")

        dept_template = wiki_cfg.get("department_wiki_template", [])
        if dept_template:
            lines.append("**Directory-level overview pages** — Each directory level in the wiki tree MUST have "
                         "an `overview.md` page that serves as the index/summary for that level. "
                         "When users click a directory node in the sidebar, this page is displayed.\n")
            lines.append("Create `overview.md` at each level:")
            lines.append("- `/wiki/销售部/overview.md` — 销售部知识总览")
            lines.append("- `/wiki/销售部/LC-Waikiki/overview.md` — LC-Waikiki客户标准总览")
            lines.append("- `/wiki/销售部/H&M/overview.md` — H&M客户标准总览")
            lines.append("")
            lines.append("Each directory overview should contain:")
            lines.append("- A summary of what this directory covers")
            lines.append("- An index of all pages under this directory")
            lines.append("- Source document count and key findings")
            lines.append("")

        global_pages = wiki_cfg.get("global_pages", [])
        if global_pages:
            lines.append(f"**Global wiki pages**: {', '.join(global_pages)}")
            lines.append("")

    # Agent behavior rules
    agent_cfg = schema.get("agent", {})
    if agent_cfg:
        lines.append("## Agent Behavior Rules\n")

        email_sources = agent_cfg.get("email_style_sources", [])
        if email_sources:
            lines.append("**When composing emails or official documents**, MUST first read:")
            for src in email_sources:
                lines.append(f"  - `read(path=\"{src}\")`")
            lines.append("")

        priority = agent_cfg.get("customer_query_priority", [])
        if priority:
            lines.append("**When answering customer queries**, search in this order:")
            for i, p in enumerate(priority, 1):
                lines.append(f"  {i}. `{p}`")
            lines.append("")

        auto_sources = agent_cfg.get("auto_reply_sources", [])
        if auto_sources:
            lines.append("**Auto-reply templates** must reference:")
            for src in auto_sources:
                lines.append(f"  - `{src}`")
            lines.append("")

    return "\n".join(lines)


def register(mcp: FastMCP, get_user_id, fs_factory) -> None:

    @mcp.tool(
        name="guide",
        description="Get started with LLM Wiki. Call this to understand how the knowledge vault works and see your available knowledge bases.",
    )
    async def guide(ctx: Context) -> str:
        user_id = get_user_id(ctx)
        fs = fs_factory(user_id)
        kbs = await fs.list_knowledge_bases()

        text = GUIDE_TEXT

        # Enterprise mode: merge SCHEMA.md config
        schema = _load_schema_config()
        if schema:
            text += "\n" + _build_enterprise_section(schema) + "\n"
        else:
            # Personal mode: merge custom GUIDE.md if present
            custom_guide = _load_custom_guide()
            if custom_guide:
                text += (
                    "\n## Workspace Custom Instructions\n\n"
                    "The workspace owner has provided the following custom instructions via `GUIDE.md`. "
                    "**Merge rules:**\n"
                    "1. **Conflict resolution**: If any instruction below contradicts the default guide above, "
                    "the custom instruction takes precedence.\n"
                    "2. **Deduplication**: If the custom instructions restate something already covered above, "
                    "follow the custom version (it may contain refinements).\n"
                    "3. **Additive**: Any new instructions below that do not conflict with the defaults are additional "
                    "requirements — apply them alongside the defaults.\n\n"
                    "---\n\n"
                    + custom_guide
                    + "\n\n"
                )

        # Append language setting if configured
        lang_code = ""
        if schema:
            lang_code = schema.get("organization", {}).get("language", "").strip().lower()
        if not lang_code:
            lang_code = settings.WIKI_LANGUAGE.strip().lower()
        if lang_code:
            lang_name = _LANGUAGE_NAMES.get(lang_code, lang_code)
            text += LANGUAGE_INSTRUCTION.format(lang_name=lang_name, lang_code=lang_code)

        if not kbs:
            return text + "\nNo knowledge bases yet. Create one at " + settings.APP_URL + "/wikis"

        text += "## Available Knowledge Bases\n\n"
        lines = []
        for kb in kbs:
            slug = kb['slug']
            src_count = kb.get('source_count', '?')
            wiki_count = kb.get('wiki_count', '?')
            lines.append(f"- **{kb['name']}** — slug: `{slug}` ({src_count} sources, {wiki_count} wiki pages)")

        text += "\n".join(lines)

        # Append explicit usage hint so agents know to pass knowledge_base
        if len(kbs) == 1:
            only_slug = kbs[0]['slug']
            text += (
                f"\n\n> **IMPORTANT**: This workspace has a single knowledge base. "
                f"All tool calls MUST include `knowledge_base=\"{only_slug}\"`. Examples:\n"
                f"> - `search(knowledge_base=\"{only_slug}\", mode=\"references\", query=\"uncited\")`\n"
                f"> - `search(knowledge_base=\"{only_slug}\", mode=\"list\", path=\"*\")`\n"
                f"> - `query(knowledge_base=\"{only_slug}\", query=\"...\", scope=\"wiki\")`\n"
                f"> - `read(knowledge_base=\"{only_slug}\", path=\"filename.pdf\")`\n"
                f"> - `write(knowledge_base=\"{only_slug}\", command=\"create\", ...)`\n"
            )
        else:
            text += (
                "\n\n> **IMPORTANT**: Every tool call MUST include `knowledge_base=\"<slug>\"` "
                "matching one of the slugs listed above. Without it, calls will fail.\n"
            )

        return text
