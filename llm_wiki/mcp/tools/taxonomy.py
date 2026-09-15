"""Taxonomy support: controlled tag vocabulary, synonym expansion, and hierarchical classification.

Loads _taxonomy.yaml from the wiki root if present. Supports both flat and nested formats:

```yaml
categories:
  - name: 生产
    tags: [工艺, 质量]
    children:
      - name: 质量
        tags: [检验标准, 质量报告]
        template: quality-doc.md
      - name: 工艺
        tags: [工艺流程, SOP]
  - name: 人事
    tags: [制度, 培训]
    children:
      - name: 制度
      - name: 培训
synonyms:
  薪资: [薪酬, 工资, salary, 待遇]
  客户: [顾客, 买家, customer]
```

When a search query contains a synonym key or value, the query is expanded
to include all related terms for better recall.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_synonym_map: dict[str, set[str]] = {}
_categories: list[dict] = []
_flat_categories: list[dict] = []  # Flattened for backward compat
_loaded = False


async def load_taxonomy_from_pg(pool) -> None:
    """Load taxonomy from PostgreSQL jz_kb_categories + jz_kb_synonyms tables."""
    global _synonym_map, _categories, _flat_categories, _loaded
    _loaded = True

    try:
        # Load categories
        rows = await pool.fetch("SELECT * FROM jz_kb_categories ORDER BY sort_order, name")
        all_cats = [dict(r) for r in rows]

        # Build tree from flat list
        by_id = {c["id"]: c for c in all_cats}
        roots = []
        for c in all_cats:
            c["children"] = []
        for c in all_cats:
            if c.get("parent_id") and c["parent_id"] in by_id:
                by_id[c["parent_id"]]["children"].append(c)
            else:
                roots.append(c)

        _categories = roots
        _flat_categories = _flatten_categories(_categories)

        # Load synonyms
        _synonym_map = {}
        syn_rows = await pool.fetch("SELECT keyword, synonyms FROM jz_kb_synonyms")
        for row in syn_rows:
            all_terms = {row["keyword"].lower()} | {v.lower() for v in (row["synonyms"] or [])}
            for term in all_terms:
                if term not in _synonym_map:
                    _synonym_map[term] = set()
                _synonym_map[term] |= all_terms

        logger.info("Loaded taxonomy from PG: %d categories, %d synonym groups",
                     len(_flat_categories), len(syn_rows))
    except Exception as e:
        logger.warning("Failed to load taxonomy from PG: %s", e)


def load_taxonomy(workspace: Path) -> None:
    """Load _taxonomy.yaml from workspace wiki root."""
    global _synonym_map, _categories, _flat_categories, _loaded
    _loaded = True

    taxonomy_path = workspace / "wiki" / "_taxonomy.yaml"
    if not taxonomy_path.is_file():
        taxonomy_path = workspace / "wiki" / "_taxonomy.yml"
    if not taxonomy_path.is_file():
        logger.debug("No _taxonomy.yaml found, synonym expansion disabled")
        return

    try:
        import yaml
        with open(taxonomy_path, encoding="utf-8") as f:
            data = yaml.safe_load(f)

        if not isinstance(data, dict):
            return

        _categories = data.get("categories", [])
        _flat_categories = _flatten_categories(_categories)

        # Build bidirectional synonym map
        _synonym_map = {}
        for key, values in data.get("synonyms", {}).items():
            all_terms = {key.lower()} | {v.lower() for v in values}
            for term in all_terms:
                if term not in _synonym_map:
                    _synonym_map[term] = set()
                _synonym_map[term] |= all_terms

        logger.info("Loaded taxonomy: %d categories (%d flat), %d synonym groups",
                     len(_categories), len(_flat_categories), len(data.get("synonyms", {})))
    except Exception as e:
        logger.warning("Failed to load _taxonomy.yaml: %s", e)


def _flatten_categories(cats: list[dict], prefix: str = "") -> list[dict]:
    """Recursively flatten nested categories into a flat list with path info."""
    result = []
    for cat in cats:
        name = cat.get("name", "")
        path = f"{prefix}/{name}" if prefix else name
        flat = {
            "name": name,
            "path": path,
            "tags": cat.get("tags", []),
            "template": cat.get("template"),
            "depth": path.count("/"),
        }
        result.append(flat)
        children = cat.get("children", [])
        if children:
            result.extend(_flatten_categories(children, path))
    return result


def expand_query(query: str) -> str:
    """Expand a search query with synonyms.

    If any word in the query matches a synonym group, adds OR-expanded terms.
    For FTS5: returns query with OR-separated synonym alternatives.

    Example: "薪资标准" → "薪资 OR 薪酬 OR 工资 OR salary OR 待遇 标准"
    """
    if not _synonym_map:
        return query

    words = query.split()
    expanded_parts = []

    for word in words:
        word_lower = word.lower()
        if word_lower in _synonym_map:
            synonyms = _synonym_map[word_lower]
            if len(synonyms) > 1:
                # FTS5 OR syntax
                expanded_parts.append("(" + " OR ".join(sorted(synonyms)) + ")")
                continue
        expanded_parts.append(word)

    result = " ".join(expanded_parts)
    if result != query:
        logger.debug("Query expanded: %r → %r", query, result)
    return result


def get_categories() -> list[dict]:
    """Return the raw category definitions from taxonomy (may be nested)."""
    return _categories


def get_flat_categories() -> list[dict]:
    """Return all categories flattened with path info."""
    return _flat_categories


def get_all_tags() -> set[str]:
    """Return all defined tags from the taxonomy (including nested children)."""
    tags = set()
    for cat in _flat_categories:
        for tag in cat.get("tags", []):
            tags.add(tag)
    return tags


def resolve_category_tree() -> str:
    """Return a formatted text tree of the category hierarchy.

    Example output:
      生产
        质量 [检验标准, 质量报告]
        工艺 [工艺流程, SOP]
      人事
        制度
        培训
    """
    if not _categories:
        return ""

    def _render(cats: list[dict], indent: int = 0) -> list[str]:
        lines = []
        prefix = "  " * indent
        for cat in cats:
            name = cat.get("name", "")
            tags = cat.get("tags", [])
            tag_str = f" [{', '.join(tags)}]" if tags else ""
            lines.append(f"{prefix}{name}{tag_str}")
            children = cat.get("children", [])
            if children:
                lines.extend(_render(children, indent + 1))
        return lines

    return "\n".join(_render(_categories))


def get_template(category_path: str) -> str | None:
    """Return the markdown template filename for a category path, if defined.

    Args:
        category_path: Slash-separated path like "生产/质量"
    """
    for cat in _flat_categories:
        if cat["path"] == category_path and cat.get("template"):
            return cat["template"]
    return None


def classify_query(query: str) -> list[str]:
    """Classify a search query against known categories.

    Returns matching category paths based on keyword overlap with
    category names, tags, and synonyms. Used for semantic query routing.

    Args:
        query: User's search query

    Returns:
        List of matching category paths, ordered by relevance (best first).
        Empty list if no category matches.
    """
    if not _flat_categories:
        return []

    query_lower = query.lower()
    query_words = set(query_lower.split())

    # Also expand query words via synonyms
    expanded_words = set(query_words)
    for word in query_words:
        if word in _synonym_map:
            expanded_words |= _synonym_map[word]

    scored: list[tuple[str, float]] = []

    for cat in _flat_categories:
        score = 0.0
        name_lower = cat["name"].lower()

        # Direct name match in query (strongest signal)
        if name_lower in query_lower:
            score += 3.0
        # Name word overlap
        elif name_lower in expanded_words:
            score += 2.0

        # Tag matches
        for tag in cat.get("tags", []):
            tag_lower = tag.lower()
            if tag_lower in query_lower:
                score += 2.0
            elif tag_lower in expanded_words:
                score += 1.0

        if score > 0:
            # Prefer deeper categories (more specific)
            score += cat.get("depth", 0) * 0.5
            scored.append((cat["path"], score))

    # Sort by score descending, return top 3
    scored.sort(key=lambda x: -x[1])
    return [path for path, _ in scored[:3]]
