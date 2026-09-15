"""File-based search engine — Obsidian-compatible, no database dependency.

Scans /wiki/ directory, parses YAML frontmatter, and performs search
using Obsidian-style operators:
  - tag:xxx         — match frontmatter tags (supports nested: tag:销售部 matches 销售部/LC-Waikiki)
  - path:xxx        — match file path
  - [property:value] — match frontmatter property
  - plain keywords   — full-text content match

This module is used when SEARCH_MODE=file (configured in config.py or SCHEMA.md).
"""

import logging
import re
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

_FRONTMATTER_RE = re.compile(r"\A---[ \t]*\n(.+?\n)---[ \t]*\n", re.DOTALL)

# Obsidian search operator patterns
_TAG_OP = re.compile(r"tag:#?([\w/\-]+)", re.UNICODE)
_PATH_OP = re.compile(r"path:([\S]+)")
_PROP_OP = re.compile(r"\[([\w]+):(.*?)\]")
_FILE_OP = re.compile(r"file:([\S]+)")


class WikiPage:
    """Parsed wiki page with frontmatter and content."""
    __slots__ = ("path", "relative", "frontmatter", "content", "raw_text")

    def __init__(self, path: Path, workspace: Path):
        self.path = path
        self.relative = str(path.relative_to(workspace))
        self.raw_text = path.read_text(encoding="utf-8", errors="replace")
        self.frontmatter: dict = {}
        self.content: str = self.raw_text

        m = _FRONTMATTER_RE.match(self.raw_text)
        if m:
            try:
                fm = yaml.safe_load(m.group(1))
                if isinstance(fm, dict):
                    self.frontmatter = fm
            except yaml.YAMLError:
                pass
            self.content = self.raw_text[m.end():]

    @property
    def title(self) -> str:
        return self.frontmatter.get("title", self.path.stem)

    @property
    def tags(self) -> list[str]:
        t = self.frontmatter.get("tags", [])
        return t if isinstance(t, list) else [str(t)]

    @property
    def description(self) -> str:
        return self.frontmatter.get("description", "")

    @property
    def date(self) -> str:
        d = self.frontmatter.get("date", "")
        return d.isoformat() if hasattr(d, "isoformat") else str(d) if d else ""

    @property
    def aliases(self) -> list[str]:
        a = self.frontmatter.get("aliases", [])
        return a if isinstance(a, list) else [str(a)]

    def get_property(self, key: str) -> str | None:
        val = self.frontmatter.get(key)
        if val is None:
            return None
        if isinstance(val, list):
            return ", ".join(str(v) for v in val)
        return str(val)


def scan_wiki_pages(workspace: Path) -> list[WikiPage]:
    """Scan the wiki/ directory and parse all markdown files."""
    wiki_dir = workspace / "wiki"
    if not wiki_dir.is_dir():
        return []

    pages: list[WikiPage] = []
    for md_file in wiki_dir.rglob("*.md"):
        try:
            pages.append(WikiPage(md_file, workspace))
        except Exception as e:
            logger.debug("Skipping %s: %s", md_file, e)
    return pages


def _match_tag(page: WikiPage, tag_query: str) -> bool:
    """Match tag with Obsidian nested tag semantics.
    tag:销售部 matches both '销售部' and '销售部/LC-Waikiki'.
    """
    tq = tag_query.lower().lstrip("#")
    for tag in page.tags:
        t = str(tag).lower()
        if t == tq or t.startswith(tq + "/"):
            return True
    # Also check inline tags in content
    if f"#{tq}" in page.content.lower():
        return True
    return False


def _match_property(page: WikiPage, prop: str, value: str) -> bool:
    """Match [property:value] query."""
    actual = page.get_property(prop)
    if actual is None:
        return False
    if not value or value == "*":
        return True  # [property] — just check existence
    return value.lower() in actual.lower()


def _match_path(page: WikiPage, path_query: str) -> bool:
    """Match path: operator."""
    return path_query.lower() in page.relative.lower()


def _match_file(page: WikiPage, file_query: str) -> bool:
    """Match file: operator."""
    return file_query.lower() in page.path.name.lower()


def _match_keywords(page: WikiPage, keywords: list[str]) -> int:
    """Match plain keywords in title + content + aliases. Returns match count."""
    searchable = " ".join([
        page.title,
        page.description,
        " ".join(page.aliases),
        " ".join(str(t) for t in page.tags),
        page.content,
    ]).lower()

    count = 0
    for kw in keywords:
        if kw.lower() in searchable:
            count += 1
    return count


class FileSearchQuery:
    """Parsed search query with Obsidian-style operators."""

    def __init__(self, query_string: str):
        self.raw = query_string
        self.tag_filters: list[str] = []
        self.path_filters: list[str] = []
        self.file_filters: list[str] = []
        self.property_filters: list[tuple[str, str]] = []  # (key, value)
        self.keywords: list[str] = []
        self.negate_keywords: list[str] = []

        self._parse(query_string)

    def _parse(self, q: str):
        remaining = q

        # Extract tag: operators
        for m in _TAG_OP.finditer(q):
            self.tag_filters.append(m.group(1))
        remaining = _TAG_OP.sub("", remaining)

        # Extract path: operators
        for m in _PATH_OP.finditer(remaining):
            self.path_filters.append(m.group(1))
        remaining = _PATH_OP.sub("", remaining)

        # Extract file: operators
        for m in _FILE_OP.finditer(remaining):
            self.file_filters.append(m.group(1))
        remaining = _FILE_OP.sub("", remaining)

        # Extract [property:value] operators
        for m in _PROP_OP.finditer(remaining):
            self.property_filters.append((m.group(1), m.group(2).strip()))
        remaining = _PROP_OP.sub("", remaining)

        # Remaining tokens are keywords
        for token in remaining.split():
            token = token.strip()
            if not token:
                continue
            if token.startswith("-"):
                self.negate_keywords.append(token[1:])
            elif token.startswith('"') and token.endswith('"'):
                self.keywords.append(token.strip('"'))
            else:
                self.keywords.append(token)


def search_pages(
    pages: list[WikiPage],
    query: str,
    limit: int = 20,
    scope: str = "all",
) -> list[tuple[WikiPage, float]]:
    """Search wiki pages with Obsidian-compatible query syntax.

    Returns list of (page, score) sorted by relevance.
    """
    parsed = FileSearchQuery(query)
    results: list[tuple[WikiPage, float]] = []

    for page in pages:
        # Scope filter
        if scope == "wiki" and not page.relative.startswith("wiki/"):
            continue
        if scope == "sources" and page.relative.startswith("wiki/"):
            continue

        score = 0.0
        match = True

        # Tag filters (all must match)
        for tag in parsed.tag_filters:
            if not _match_tag(page, tag):
                match = False
                break
        if not match:
            continue

        # Path filters (all must match)
        for pf in parsed.path_filters:
            if not _match_path(page, pf):
                match = False
                break
        if not match:
            continue

        # File filters
        for ff in parsed.file_filters:
            if not _match_file(page, ff):
                match = False
                break
        if not match:
            continue

        # Property filters (all must match)
        for prop, val in parsed.property_filters:
            if not _match_property(page, prop, val):
                match = False
                break
        if not match:
            continue

        # Negate keywords
        for nk in parsed.negate_keywords:
            if nk.lower() in page.content.lower():
                match = False
                break
        if not match:
            continue

        # Keyword scoring
        if parsed.keywords:
            kw_count = _match_keywords(page, parsed.keywords)
            if kw_count == 0 and not (parsed.tag_filters or parsed.property_filters or parsed.path_filters):
                continue  # No match at all
            score += kw_count * 10
        elif parsed.tag_filters or parsed.property_filters:
            score += 5  # Matched by operators alone

        # Bonus for title match
        title_lower = page.title.lower()
        for kw in parsed.keywords:
            if kw.lower() in title_lower:
                score += 20

        # Bonus for tag match count
        score += len(parsed.tag_filters) * 3

        results.append((page, score))

    results.sort(key=lambda x: -x[1])
    return results[:limit]


def format_search_results(results: list[tuple[WikiPage, float]], query: str) -> str:
    """Format search results as markdown."""
    if not results:
        return f'No results found for "{query}" in wiki files.'

    lines = [f"**{len(results)} result(s)** for `{query}` (file search):\n"]

    for page, score in results:
        tags_str = " ".join(f"`{t}`" for t in page.tags[:5]) if page.tags else ""
        # Show relevant properties
        props = []
        for key in ("customer", "product_line", "supplier", "brand", "department"):
            val = page.get_property(key)
            if val:
                props.append(f"{key}={val}")
        props_str = f" [{', '.join(props)}]" if props else ""

        lines.append(f"**{page.title}** — `{page.relative}`{props_str}")
        if page.description:
            lines.append(f"  {page.description}")
        if tags_str:
            lines.append(f"  Tags: {tags_str}")

        # Extract snippet around first keyword match
        snippet = _extract_snippet(page.content, query)
        if snippet:
            lines.append(f"  ```\n  {snippet}\n  ```")
        lines.append("")

    return "\n".join(lines)


def format_full_results(results: list[tuple[WikiPage, float]], query: str, max_chars: int = 120_000) -> str:
    """Format full-content results (for query tool)."""
    if not results:
        return f'No results found for "{query}" in wiki files.'

    lines = [f"**{len(results)} result(s)** for `{query}` (file search):\n"]
    total = 0

    for page, score in results:
        content = page.content.strip()
        remaining = max_chars - total
        if remaining <= 0:
            lines.append(f"\n*Budget exceeded — more results omitted.*")
            break

        if len(content) > min(30_000, remaining):
            content = content[:min(30_000, remaining)] + f"\n\n... (truncated)"
        total += len(content)

        props = []
        for key in ("customer", "product_line", "supplier", "brand", "department"):
            val = page.get_property(key)
            if val:
                props.append(f"{key}: {val}")
        props_str = f"\n**Properties:** {', '.join(props)}" if props else ""

        lines.append(f"---")
        lines.append(f"### {page.title}")
        lines.append(f"**Path:** `{page.relative}`{props_str}")
        if page.tags:
            lines.append(f"**Tags:** {', '.join(str(t) for t in page.tags)}")
        lines.append("")
        lines.append(content)

    return "\n".join(lines)


def _extract_snippet(content: str, query: str, context: int = 120) -> str:
    """Extract a context snippet around the first keyword match."""
    # Use the first keyword-like term
    terms = [t for t in query.split() if not t.startswith(("tag:", "path:", "file:", "[", "-"))]
    if not terms:
        return content[:context * 2].strip() if content else ""

    for term in terms:
        idx = content.lower().find(term.lower())
        if idx >= 0:
            start = max(0, idx - context)
            end = min(len(content), idx + len(term) + context)
            snippet = content[start:end].strip().replace("\n", " ")
            if start > 0:
                snippet = "..." + snippet
            if end < len(content):
                snippet += "..."
            return snippet

    return content[:context * 2].strip() if content else ""
