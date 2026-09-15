"""Query tool — full-text knowledge retrieval from the wiki knowledge base.

This tool enables agents to search wiki content and retrieve complete,
contextual answers. Unlike the search tool which returns short snippets,
query returns full document content suitable for knowledge extraction.
"""

import logging
from typing import Literal

from mcp.server.fastmcp import FastMCP, Context

from vaultfs import VaultFS
from .helpers import deep_link, resolve_path, glob_match, MAX_SEARCH

logger = logging.getLogger(__name__)

_MAX_CONTENT_CHARS = 120_000  # total content budget across all results
_MAX_PER_DOC_CHARS = 30_000  # max content per single document


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n\n... (truncated, {len(text) - limit} chars omitted)"


def _strip_frontmatter(content: str) -> str:
    """Strip YAML frontmatter from markdown content."""
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            return content[end + 3:].lstrip("\n")
    return content


class QueryHandler:
    """Retrieves full wiki content matching a query for knowledge extraction."""

    def __init__(self, fs: VaultFS, kb: dict, scopes: set[str] | None = None):
        self.fs = fs
        self.kb = kb
        self.kb_id = str(kb["id"])
        self.slug = kb.get("slug") or kb["name"]
        self.scopes = scopes

    async def retrieve(
        self,
        query: str,
        scope: str,
        limit: int,
        include_references: bool,
    ) -> str:
        """Search and retrieve full document content."""
        path_filter = self._scope_to_filter(scope)

        # Try FTS chunk-based search first
        docs = await self.fs.search_documents_full(
            self.kb_id, query, limit, path_filter, scopes=self.scopes,
        )

        # Fallback: direct content search (covers wiki pages without chunks)
        if not docs:
            keywords = [k.strip() for k in query.split() if k.strip()]
            docs = await self.fs.search_documents_by_content(
                self.kb_id, keywords, limit, path_filter, scopes=self.scopes,
            )

        if not docs:
            return f"No results found for \"{query}\" in knowledge base \"{self.slug}\"."

        lines = [
            f"**{len(docs)} result(s)** for \"{query}\" in **{self.kb['name']}**:\n",
        ]

        total_chars = 0
        for doc in docs:
            content = doc.get("content") or ""
            title = doc.get("title") or doc["filename"]
            filepath = f"{doc['path']}{doc['filename']}"
            link = deep_link(self.slug, doc["path"], doc["filename"])
            tags = doc.get("tags") or []
            tag_str = f"  Tags: {', '.join(tags)}" if tags else ""

            # Truncate individual doc content
            display_content = _strip_frontmatter(content)
            remaining = _MAX_CONTENT_CHARS - total_chars
            if remaining <= 0:
                lines.append(f"\n---\n*Budget exceeded — {len(docs) - docs.index(doc)} more results omitted.*")
                break

            doc_limit = min(_MAX_PER_DOC_CHARS, remaining)
            display_content = _truncate(display_content, doc_limit)
            total_chars += len(display_content)

            lines.append(f"---")
            lines.append(f"### {title}")
            lines.append(f"**Path:** `{filepath}` — [view]({link}){tag_str}")
            lines.append(f"")
            lines.append(display_content)

            # Optionally append related references
            if include_references:
                ref_lines = await self._get_ref_summary(str(doc["id"]))
                if ref_lines:
                    lines.append("")
                    lines.extend(ref_lines)

        return "\n".join(lines)

    async def retrieve_by_tags(self, tags: list[str], scope: str, limit: int) -> str:
        """Retrieve documents matching all given tags."""
        docs = await self.fs.list_documents_with_content(self.kb_id, scopes=self.scopes)

        # Filter by scope
        if scope == "wiki":
            docs = [d for d in docs if d["path"].startswith("/wiki/")]
        elif scope == "sources":
            docs = [d for d in docs if not d["path"].startswith("/wiki/")]

        # Filter by tags
        tag_set = {t.lower() for t in tags}
        docs = [d for d in docs if tag_set.issubset({t.lower() for t in (d.get("tags") or [])})]

        if not docs:
            return f"No documents found with tags [{', '.join(tags)}]."

        docs = docs[:limit]
        lines = [f"**{len(docs)} document(s)** with tags [{', '.join(tags)}]:\n"]

        total_chars = 0
        for doc in docs:
            content = doc.get("content") or ""
            title = doc.get("title") or doc["filename"]
            filepath = f"{doc['path']}{doc['filename']}"
            link = deep_link(self.slug, doc["path"], doc["filename"])

            display_content = _strip_frontmatter(content)
            remaining = _MAX_CONTENT_CHARS - total_chars
            if remaining <= 0:
                lines.append(f"\n---\n*Budget exceeded — more results omitted.*")
                break

            doc_limit = min(_MAX_PER_DOC_CHARS, remaining)
            display_content = _truncate(display_content, doc_limit)
            total_chars += len(display_content)

            lines.append(f"---")
            lines.append(f"### {title}")
            lines.append(f"**Path:** `{filepath}` — [view]({link})")
            lines.append(f"")
            lines.append(display_content)

        return "\n".join(lines)

    async def _get_ref_summary(self, doc_id: str) -> list[str]:
        """Get a brief summary of references for a document."""
        forward = await self.fs.get_forward_references(doc_id)
        backlinks = await self.fs.get_backlinks(doc_id)

        lines = []
        if forward:
            cites = [r for r in forward if r["reference_type"] == "cites"]
            links = [r for r in forward if r["reference_type"] == "links_to"]
            parts = []
            if cites:
                parts.append(f"cites {len(cites)} source(s)")
            if links:
                parts.append(f"links to {len(links)} page(s): " +
                    ", ".join(f"`{r['path']}{r['filename']}`" for r in links[:5]))
            if parts:
                lines.append(f"**References:** {'; '.join(parts)}")

        if backlinks:
            lines.append(f"**Referenced by:** " +
                ", ".join(f"`{r['path']}{r['filename']}`" for r in backlinks[:5]))

        return lines

    def _scope_to_filter(self, scope: str) -> str | None:
        if scope == "wiki":
            return "wiki"
        if scope == "sources":
            return "sources"
        return None


def register(mcp: FastMCP, get_user_id, fs_factory) -> None:

    @mcp.tool(
        name="query",
        description=(
            "Retrieve knowledge from the wiki — returns full document content, not just snippets.\n\n"
            "Use this tool when you need to:\n"
            "- Look up standards, specifications, or procedures documented in the wiki\n"
            "- Find detailed information about a customer, product, or concept\n"
            "- Gather context from the knowledge base to complete a task\n"
            "- Answer questions using information stored in wiki pages\n\n"
            "Unlike `search` (which returns short snippets for browsing), `query` returns the "
            "complete content of matching wiki pages so you can extract precise answers.\n\n"
            "Examples:\n"
            "- `query(query=\"客户A生产标准\")` — retrieve production standards for customer A\n"
            "- `query(query=\"焊接工艺参数\", scope=\"wiki\")` — get welding process parameters from wiki pages\n"
            "- `query(tags=[\"质量标准\", \"客户A\"])` — retrieve all docs tagged with both tags\n"
            "- `query(query=\"packaging requirements\", include_references=true)` — include related page links\n"
        ),
    )
    async def query(
        ctx: Context,
        knowledge_base: str,
        query: str = "",
        tags: list[str] | None = None,
        scope: Literal["all", "wiki", "sources"] = "wiki",
        limit: int = 5,
        include_references: bool = False,
    ) -> str:
        """Full-text knowledge retrieval from the wiki.

        Args:
            knowledge_base: Name or slug of the knowledge base to search.
            query: Search query — keywords or natural language question.
            tags: Filter results to documents matching ALL given tags.
            scope: Restrict search to "wiki" pages, "sources", or "all".
            limit: Maximum number of documents to return (default 5, max 10).
            include_references: Include citation and cross-reference info for each result.
        """
        user_id = get_user_id(ctx)
        fs = fs_factory(user_id)

        if not knowledge_base:
            return "Please specify a knowledge_base name."

        kb = await fs.resolve_kb(knowledge_base)
        if not kb:
            return f"Knowledge base '{knowledge_base}' not found."

        # Resolve enterprise access scopes
        scopes = None
        if hasattr(fs, "accessible_scopes"):
            scopes = await fs.accessible_scopes()

        effective_limit = min(limit, 10)

        # Route to file-based search if configured
        from .search import _get_search_mode
        if _get_search_mode() == "file":
            from vaultfs.sqlite import _workspace_root
            if _workspace_root:
                from .file_search import scan_wiki_pages, search_pages, format_full_results
                pages = scan_wiki_pages(_workspace_root)
                full_query = query or ""
                if tags:
                    full_query += " " + " ".join(f"tag:{t}" for t in tags)
                if not full_query.strip():
                    return "Please provide a `query` or `tags` to search."
                results = search_pages(pages, full_query, limit=effective_limit, scope=scope)
                return format_full_results(results, query or " ".join(tags))

        handler = QueryHandler(fs, kb, scopes=scopes)

        if tags and not query:
            return await handler.retrieve_by_tags(tags, scope, effective_limit)

        if not query:
            return "Please provide a `query` or `tags` to search."

        return await handler.retrieve(query, scope, effective_limit, include_references)
