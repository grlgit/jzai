"""Search tool — browse, search, and query references in the knowledge vault."""

import logging
from typing import Literal

from mcp.server.fastmcp import FastMCP, Context

from config import settings
from vaultfs import VaultFS
from .helpers import deep_link, glob_match, resolve_path, MAX_LIST, MAX_SEARCH

logger = logging.getLogger(__name__)


def _get_search_mode() -> str:
    """Determine search mode: 'db' or 'file'."""
    # SCHEMA.md override
    try:
        from local_server import _schema_config
        if _schema_config:
            mode = _schema_config.get("organization", {}).get("search_mode", "")
            if mode in ("db", "file"):
                return mode
    except (ImportError, AttributeError):
        pass
    return settings.SEARCH_MODE.strip().lower() or "db"

_CONTEXT_CHARS = 120


def _extract_snippet(content: str, query: str) -> str:
    """Extract a context snippet around a query match."""
    if not content:
        return "(empty)"
    idx = content.lower().find(query.lower())
    if idx < 0:
        return content[:_CONTEXT_CHARS * 2].strip()
    start = max(0, idx - _CONTEXT_CHARS)
    end = min(len(content), idx + len(query) + _CONTEXT_CHARS)
    snippet = content[start:end].strip()
    if start > 0:
        snippet = "..." + snippet
    if end < len(content):
        snippet = snippet + "..."
    return snippet


class SearchHandler:
    """Executes list, search, and reference queries on the knowledge vault."""

    def __init__(self, fs: VaultFS, kb: dict, scopes: set[str] | None = None):
        self.fs = fs
        self.kb = kb
        self.kb_id = str(kb["id"])
        self.slug = kb["slug"]
        self.scopes = scopes  # Enterprise access scopes (None = no filtering)

    async def list_documents(self, target: str, tags: list[str] | None) -> str:
        """List documents matching a glob pattern and optional tag filter."""
        docs = await self.fs.list_documents(self.kb_id, scopes=self.scopes)

        if target not in ("*", "**", "**/*"):
            glob_pat = "/" + target.lstrip("/") if not target.startswith("/") else target
            docs = [d for d in docs if glob_match(d["path"] + d["filename"], glob_pat)]

        if tags:
            tag_set = {t.lower() for t in tags}
            docs = [d for d in docs if tag_set.issubset({t.lower() for t in (d.get("tags") or [])})]

        if not docs:
            return f"No matches for `{target}` in {self.slug}."

        sources = [d for d in docs if not d["path"].startswith("/wiki/")]
        wiki_pages = [d for d in docs if d["path"].startswith("/wiki/")]

        # Get compilation status for source docs
        compile_status = {}
        try:
            compile_status = await self.fs.get_source_compilation_status(self.kb_id)
        except Exception:
            pass

        lines = [f"**{self.kb['name']}** (`{target}`):\n"]

        if sources:
            lines.append(f"**Sources ({len(sources)}):**")
            for doc in sources[:MAX_LIST]:
                sid = str(doc.get("id", ""))
                status = compile_status.get(sid, "uncited")
                status_label = {"current": "[已编译]", "needs_update": "[需更新]"}.get(status, "[未编译]")
                lines.append(self._format_source_line(doc) + f" {status_label}")
            if len(sources) > MAX_LIST:
                lines.append(f"  ... {len(sources) - MAX_LIST} more")

        if wiki_pages:
            if sources:
                lines.append("")
            lines.append(f"**Wiki ({len(wiki_pages)} pages):**")
            for doc in wiki_pages[:MAX_LIST]:
                lines.append(self._format_wiki_line(doc))

        return "\n".join(lines)

    async def search_chunks(self, query: str, path: str, tags: list[str] | None, limit: int) -> str:
        """Hybrid search across document chunks (FTS5 + vector similarity when available)."""
        path_filter = self._path_filter_key(path)

        # Expand query with synonyms from taxonomy
        try:
            from tools.taxonomy import expand_query
            expanded = expand_query(query)
        except Exception:
            expanded = query

        # Semantic query routing: classify query against taxonomy categories
        # If matched, use category path to scope the search for better precision
        routed_categories: list[str] = []
        try:
            from tools.taxonomy import classify_query
            routed_categories = classify_query(query)
        except Exception:
            pass

        # Use hybrid search if available, fallback to FTS-only
        if hasattr(self.fs, 'search_chunks_hybrid'):
            matches = await self.fs.search_chunks_hybrid(self.kb_id, expanded, limit, path_filter, scopes=self.scopes)
        else:
            matches = await self.fs.search_chunks(self.kb_id, expanded, limit, path_filter, scopes=self.scopes)

        if tags:
            tag_set = {t.lower() for t in tags}
            matches = [m for m in matches if tag_set.issubset({t.lower() for t in (m.get("tags") or [])})]

        # If taxonomy routing found categories but search returned few results,
        # boost results from matching category paths
        if routed_categories and matches:
            def _category_boost(match: dict) -> float:
                """Score boost for matches in routed category paths."""
                match_path = (match.get("path") or "").lower()
                for cat_path in routed_categories:
                    # Check if doc path contains the category name
                    for segment in cat_path.lower().split("/"):
                        if segment and segment in match_path:
                            return 1.0
                return 0.0

            # Re-sort: original score + category boost
            for m in matches:
                m["_boost"] = _category_boost(m)
            matches.sort(key=lambda m: -(m.get("score", 0) + m.get("_boost", 0)))

        if not matches:
            hint = ""
            if routed_categories:
                hint = f" (检测到相关领域: {', '.join(routed_categories)})"
            return f"No matches for `{query}` in {self.slug}.{hint}"

        lines = [f"**{len(matches)} result(s)** for `{query}`:\n"]
        if routed_categories:
            lines.append(f"*语义路由: {', '.join(routed_categories)}*\n")
        for m in matches:
            lines.append(self._format_search_result(m, query))

        # Append related topic suggestions based on taxonomy siblings and result tags
        try:
            suggestions = self._suggest_related_topics(query, matches, routed_categories)
            if suggestions:
                lines.append(f"\n---\n**你可能还想搜索：** {', '.join(suggestions)}")
        except Exception:
            pass

        return "\n".join(lines)

    async def query_references(self, path: str, query: str) -> str:
        """Query the citation/link graph."""
        if query == "uncited":
            return await self._find_uncited()
        if query == "stale":
            return await self._find_stale()
        if query == "conflicts":
            return await self._find_conflicts()
        return await self._document_references(path)

    async def _find_conflicts(self) -> str:
        """Find open knowledge conflicts (duplicates, contradictions)."""
        try:
            from vaultfs.sqlite import _db
            if _db is None:
                return "Conflict detection not available."
            from services.graph_builder import get_conflicts
            conflicts = await get_conflicts(_db, status="open")
            if not conflicts:
                return "No open knowledge conflicts found."
            lines = [f"**{len(conflicts)} open conflict(s):**\n"]
            for c in conflicts:
                ctype = "重复" if c["conflict_type"] == "duplicate" else "矛盾"
                doc_a = c.get("doc_a_title") or c.get("doc_a_filename") or "?"
                doc_b = c.get("doc_b_title") or c.get("doc_b_filename") or "?"
                lines.append(f"  - [{ctype}] {c['description'][:100]}")
                lines.append(f"    文档A: {doc_a} / 文档B: {doc_b}")
            return "\n".join(lines)
        except Exception as e:
            return f"Conflict detection error: {e}"

    async def _find_uncited(self) -> str:
        """Find source documents not cited by any wiki page."""
        rows = await self.fs.find_uncited_sources(self.kb_id, scopes=self.scopes)
        if not rows:
            return "All sources are cited in at least one wiki page."
        lines = [f"**{len(rows)} uncited source(s)** — not referenced by any wiki page:\n"]
        for r in rows:
            lines.append(f"  {r['path']}{r['filename']} ({r['file_type']})")
        return "\n".join(lines)

    async def _find_stale(self) -> str:
        """Find wiki pages flagged as potentially stale."""
        rows = await self.fs.find_stale_pages(self.kb_id, scopes=self.scopes)
        if not rows:
            return "No stale pages found."
        lines = [f"**{len(rows)} potentially stale page(s)** — a page they reference was updated:\n"]
        for r in rows:
            stale = r["stale_since"]
            if hasattr(stale, "strftime"):
                stale = stale.strftime("%Y-%m-%d %H:%M")
            title = r["title"] or r["filename"]
            lines.append(f"  {r['path']}{r['filename']} ({title}) — stale since {stale or '?'}")
        return "\n".join(lines)

    async def _document_references(self, path: str) -> str:
        """Show forward references and backlinks for a specific document."""
        if not path or path in ("*", "**"):
            return "references mode requires a `path` to a specific document, or `query=\"uncited\"` / `query=\"stale\"`."

        dir_path, filename = resolve_path(path)
        doc = await self.fs.get_document(self.kb_id, filename, dir_path)
        if not doc:
            return f"Document '{path}' not found."

        doc_id = str(doc["id"])
        forward = await self.fs.get_forward_references(doc_id)
        backlinks = await self.fs.get_backlinks(doc_id)

        title = doc.get("title") or doc["filename"]
        lines = [f"**References for {title}** (`{dir_path}{filename}`):\n"]

        if forward:
            cites = [r for r in forward if r["reference_type"] == "cites"]
            links = [r for r in forward if r["reference_type"] == "links_to"]
            if cites:
                lines.append(f"**Cites ({len(cites)} sources):**")
                for r in cites:
                    page_str = f", p.{r['page']}" if r.get("page") else ""
                    lines.append(f"  {r['path']}{r['filename']}{page_str}")
            if links:
                lines.append(f"\n**Links to ({len(links)} pages):**")
                for r in links:
                    lines.append(f"  {r['path']}{r['filename']} ({r.get('title') or r['filename']})")
        else:
            lines.append("No outgoing references.")

        lines.append("")
        if backlinks:
            lines.append(f"**Referenced by ({len(backlinks)} pages):**")
            for r in backlinks:
                ref = "cites" if r["reference_type"] == "cites" else "links to"
                lines.append(f"  {r['path']}{r['filename']} ({r.get('title') or r['filename']}) — {ref}")
        else:
            lines.append("No incoming references (backlinks).")

        return "\n".join(lines)

    def _suggest_related_topics(self, query: str, matches: list[dict],
                                routed_categories: list[str]) -> list[str]:
        """Generate related topic suggestions based on taxonomy siblings and result tags."""
        from .taxonomy import get_flat_categories

        suggestions: list[str] = []
        seen = {query.lower()}

        # 1. Sibling categories from taxonomy (if routed)
        flat_cats = get_flat_categories()
        for routed in routed_categories:
            # Find parent path
            parts = routed.rsplit("/", 1)
            parent = parts[0] if len(parts) > 1 else ""
            for cat in flat_cats:
                cat_parts = cat["path"].rsplit("/", 1)
                cat_parent = cat_parts[0] if len(cat_parts) > 1 else ""
                if cat_parent == parent and cat["path"] != routed:
                    name = cat["name"]
                    if name.lower() not in seen:
                        suggestions.append(name)
                        seen.add(name.lower())

        # 2. Tags from search results that weren't in the query
        for m in matches[:5]:
            for tag in (m.get("tags") or []):
                if tag.lower() not in seen and tag.lower() not in query.lower():
                    suggestions.append(tag)
                    seen.add(tag.lower())

        return suggestions[:5]

    def _path_filter_key(self, path: str) -> str | None:
        """Map a path pattern to a search filter key."""
        if path in ("*", "**", "**/*"):
            return None
        if path.startswith("/wiki"):
            return "wiki"
        if path in ("/", "/*"):
            return "sources"
        return None

    def _format_source_line(self, doc: dict) -> str:
        """Format a single source document for list output."""
        tag_str = f" [{', '.join(doc['tags'])}]" if doc.get("tags") else ""
        date_part = ""
        if doc.get("updated_at"):
            date_val = doc["updated_at"]
            date_part = f", {date_val.strftime('%Y-%m-%d') if hasattr(date_val, 'strftime') else date_val}"
        pages_part = f", {doc['page_count']}p" if doc.get("page_count") else ""
        return f"  {doc['path']}{doc['filename']} ({doc.get('file_type', '')}{pages_part}{date_part}){tag_str}"

    def _format_wiki_line(self, doc: dict) -> str:
        """Format a single wiki page for list output."""
        date_part = ""
        if doc.get("updated_at"):
            date_val = doc["updated_at"]
            date_part = f", {date_val.strftime('%Y-%m-%d') if hasattr(date_val, 'strftime') else date_val}"
        return f"  {doc['path']}{doc['filename']}{date_part}"

    def _format_search_result(self, match: dict, query: str) -> str:
        """Format a single search result with snippet."""
        filepath = f"{match['path']}{match['filename']}"
        page_str = f" (p.{match['page']})" if match.get("page") else ""
        breadcrumb = f"\n  {match['header_breadcrumb']}" if match.get("header_breadcrumb") else ""
        snippet = _extract_snippet(match.get("content", ""), query)
        link = deep_link(self.slug, match["path"], match["filename"])
        score = match.get("score", 0)
        score_str = f" [{score:.1f}]" if score else ""
        return f"**{filepath}**{page_str}{score_str} — [view]({link}){breadcrumb}\n```\n{snippet}\n```\n"


    async def generate_digest(self) -> str:
        """Generate a lightweight knowledge digest (~1500 chars) for system prompt injection.

        Returns a compact summary: category tree, tag cloud, and recent documents.
        """
        docs = await self.fs.list_documents(self.kb_id, scopes=self.scopes)
        if not docs:
            return f"知识库 **{self.kb['name']}** 当前为空。"

        # 1. Category tree: group wiki pages by top-level path
        wiki_docs = [d for d in docs if d["path"].startswith("/wiki/") and not d["path"].startswith("/wiki/_")]
        source_docs = [d for d in docs if not d["path"].startswith("/wiki/")]

        category_counts: dict[str, int] = {}
        for d in wiki_docs:
            # Extract first directory level under /wiki/
            parts = d["path"].strip("/").split("/")
            cat = parts[1] if len(parts) > 1 else "(根)"
            category_counts[cat] = category_counts.get(cat, 0) + 1

        # 2. Tag cloud and category tree from taxonomy
        from .taxonomy import get_all_tags, resolve_category_tree
        all_tags = get_all_tags()
        category_tree = resolve_category_tree()

        # 3. Recent documents (last 5 updated)
        ready_docs = [d for d in docs if d.get("status") == "ready" and not d["path"].startswith("/wiki/_")]
        ready_docs.sort(key=lambda d: d.get("updated_at") or d.get("created_at") or "", reverse=True)
        recent = ready_docs[:5]

        # Assemble digest (strict 1500 char budget)
        lines: list[str] = [f"**{self.kb['name']}** — {len(wiki_docs)} 百科页 / {len(source_docs)} 源文档\n"]

        if category_counts:
            lines.append("**知识领域：**")
            for cat, count in sorted(category_counts.items(), key=lambda x: -x[1]):
                lines.append(f"  - {cat} ({count}篇)")

        if category_tree:
            # Show taxonomy tree (truncate if too long)
            tree_lines = category_tree.split("\n")[:15]
            lines.append(f"\n**分类体系：**")
            lines.extend(f"  {l}" for l in tree_lines)

        if all_tags:
            tag_list = sorted(all_tags)[:20]  # Max 20 tags
            lines.append(f"**标签：** {', '.join(tag_list)}")

        if recent:
            lines.append("\n**最近更新：**")
            for d in recent:
                title = d.get("title") or d["filename"]
                date_val = d.get("updated_at") or d.get("created_at") or ""
                if hasattr(date_val, "strftime"):
                    date_val = date_val.strftime("%m-%d")
                elif isinstance(date_val, str) and len(date_val) >= 10:
                    date_val = date_val[5:10]
                lines.append(f"  - {title} ({date_val})")

        digest = "\n".join(lines)
        # Hard cap at 1500 chars
        if len(digest) > 1500:
            digest = digest[:1497] + "..."
        return digest


async def _list_all_kbs(fs: VaultFS) -> str:
    """List all knowledge bases for the user."""
    kbs = await fs.list_knowledge_bases()
    if not kbs:
        return "No knowledge bases found."

    lines = ["**Knowledge Bases:**\n"]
    for kb in kbs:
        lines.append(f"  {kb['slug']}/ — {kb['name']}")
    return "\n".join(lines)


def register(mcp: FastMCP, get_user_id, fs_factory) -> None:

    @mcp.tool(
        name="search",
        description=(
            "Browse or search the knowledge vault.\n\n"
            "Sources (raw documents) live at `/`. Wiki pages (LLM-compiled) live at `/wiki/`.\n\n"
            "Modes:\n"
            "- list: browse files and folders\n"
            "- search: keyword search across document content (searches chunks for precise results with page numbers)\n"
            "- references: query the citation/link graph for a document\n"
            "- digest: compact knowledge base summary (categories, tags, recent docs) for context injection\n\n"
            "References mode examples:\n"
            "- `search(mode=\"references\", path=\"/wiki/concepts/scaling.md\")` — what it cites + what links to it\n"
            "- `search(mode=\"references\", path=\"paper.pdf\")` — which wiki pages cite this source\n"
            "- `search(mode=\"references\", query=\"uncited\")` — sources with no wiki citations\n"
            "- `search(mode=\"references\", query=\"stale\")` — pages flagged as potentially stale\n\n"
            "Use `path` to scope: `*` for root, `/wiki/**` for wiki only, `*.pdf` for PDFs, etc.\n"
            "Use `tags` to filter by document tags."
        ),
    )
    async def search(
        ctx: Context,
        knowledge_base: str,
        mode: Literal["list", "search", "references", "digest"] = "list",
        query: str = "",
        path: str = "*",
        tags: list[str] | None = None,
        limit: int = 10,
        user_email: str = "",
        scopes: list[str] | None = None,
    ) -> str:
        user_id = get_user_id(ctx)
        fs = fs_factory(user_id)

        if not knowledge_base:
            return await _list_all_kbs(fs)

        kb = await fs.resolve_kb(knowledge_base)
        if not kb:
            return f"Knowledge base '{knowledge_base}' not found."

        # Resolve enterprise access scopes (None = no filtering)
        # explicit scopes come from the trusted main platform; otherwise resolve from user identity
        resolved_scopes = None
        if hasattr(fs, "accessible_scopes"):
            resolved_scopes = await fs.accessible_scopes(
                user_email or None, explicit_scopes=scopes
            )

        handler = SearchHandler(fs, kb, scopes=resolved_scopes)

        if mode == "list":
            return await handler.list_documents(path, tags)
        elif mode == "search":
            if not query:
                return "search mode requires a query."

            # Route to file-based search if configured
            if _get_search_mode() == "file":
                from vaultfs.sqlite import _workspace_root
                if _workspace_root:
                    from .file_search import scan_wiki_pages, search_pages, format_search_results
                    pages = scan_wiki_pages(_workspace_root)
                    # Build combined query with path filter
                    full_query = query
                    if path and path not in ("*", "**", "**/*"):
                        full_query = f"path:{path} {query}"
                    if tags:
                        full_query += " " + " ".join(f"tag:{t}" for t in tags)
                    results = search_pages(pages, full_query, limit=min(limit, MAX_SEARCH))
                    return format_search_results(results, query)

            return await handler.search_chunks(query, path, tags, min(limit, MAX_SEARCH))
        elif mode == "references":
            return await handler.query_references(path, query)
        elif mode == "digest":
            return await handler.generate_digest()

        return f"Unknown mode: {mode}"
