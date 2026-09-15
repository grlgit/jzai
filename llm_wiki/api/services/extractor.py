"""Knowledge extraction service — async LLM post-processing for documents.

After a document is indexed (chunked into FTS5), this service extracts
structured knowledge: entities, facts, categories, and a summary.

Extraction is fire-and-forget — failures are logged but never block
document processing or raise to callers.
"""

import json
import logging
import os
import uuid

import httpx

logger = logging.getLogger(__name__)

# LLM config for extraction (configurable via environment)
EXTRACT_ENDPOINT = os.environ.get('EXTRACT_ENDPOINT', 'https://api.deepseek.com/v1')
EXTRACT_MODEL = os.environ.get('EXTRACT_MODEL', 'deepseek-chat')
EXTRACT_API_KEY = os.environ.get('EXTRACT_API_KEY', '')

# Maximum content length sent to LLM (chars) — avoid blowing up context window
MAX_CONTENT_LENGTH = 12000

EXTRACTION_PROMPT = """从以下文档内容中提取结构化知识。请返回JSON格式：

{
  "entities": [{"name": "实体名", "type": "person|org|product|concept|location", "description": "简述"}],
  "facts": [{"claim": "事实陈述", "page": null, "confidence": "high|medium|low"}],
  "categories": ["建议分类1", "建议分类2"],
  "summary": "2-3句话摘要"
}

注意：
- entities 中的 type 只能是 person, org, product, concept, location 之一
- facts 中的 confidence 只能是 high, medium, low 之一
- 如果文档内容不足以提取某类信息，该字段返回空数组或空字符串
- 只返回JSON，不要包含其他文字

文档内容：
---
{content}"""


def is_available() -> bool:
    """Check if extraction service is configured."""
    return bool(EXTRACT_API_KEY)


async def extract_knowledge(content: str) -> dict | None:
    """Call LLM to extract structured knowledge from document content.

    Returns a dict with keys: entities, facts, categories, summary.
    Returns None if service is unavailable or extraction fails.
    """
    if not EXTRACT_API_KEY:
        logger.debug("Extraction skipped: EXTRACT_API_KEY not configured")
        return None

    # Truncate content to avoid exceeding context window
    truncated = content[:MAX_CONTENT_LENGTH]
    if len(content) > MAX_CONTENT_LENGTH:
        truncated += "\n\n[... 内容已截断 ...]"

    prompt = EXTRACTION_PROMPT.format(content=truncated)

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
            resp = await client.post(
                f"{EXTRACT_ENDPOINT.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {EXTRACT_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": EXTRACT_MODEL,
                    "messages": [
                        {"role": "system", "content": "你是一个知识提取助手，只返回JSON格式的结构化数据。"},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.1,
                    "response_format": {"type": "json_object"},
                },
            )
            resp.raise_for_status()
            data = resp.json()

        raw_text = data["choices"][0]["message"]["content"]
        result = json.loads(raw_text)

        # Validate expected keys exist
        validated = {
            "entities": result.get("entities", []),
            "facts": result.get("facts", []),
            "categories": result.get("categories", []),
            "summary": result.get("summary", ""),
        }
        return validated

    except httpx.HTTPStatusError as e:
        logger.warning("Extraction LLM call failed (HTTP %s): %s", e.response.status_code, str(e)[:200])
        return None
    except json.JSONDecodeError as e:
        logger.warning("Extraction LLM returned invalid JSON: %s", str(e)[:200])
        return None
    except Exception as e:
        logger.warning("Extraction failed: %s", str(e)[:200])
        return None


async def store_extractions(db, document_id: str, extractions: dict) -> None:
    """Store extraction results in document_extractions table (upsert).

    Args:
        db: aiosqlite.Connection
        document_id: the document ID
        extractions: dict with keys entities, facts, categories, summary
    """
    for ext_type in ("entities", "facts", "categories", "summary"):
        value = extractions.get(ext_type)
        if value is None:
            continue

        # Serialize to JSON string for storage
        if isinstance(value, (list, dict)):
            content_str = json.dumps(value, ensure_ascii=False)
        else:
            content_str = str(value)

        ext_id = str(uuid.uuid4())
        # Upsert: INSERT OR REPLACE (UNIQUE on document_id + extraction_type)
        await db.execute(
            "INSERT INTO document_extractions (id, document_id, extraction_type, content) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(document_id, extraction_type) DO UPDATE SET "
            "content = excluded.content, created_at = datetime('now')",
            (ext_id, document_id, ext_type, content_str),
        )

    await db.commit()
    logger.info("Stored extractions for document %s", document_id[:8])


async def get_extractions(db, document_id: str) -> list[dict]:
    """Retrieve all extractions for a document.

    Args:
        db: aiosqlite.Connection
        document_id: the document ID

    Returns:
        List of dicts with keys: extraction_type, content (parsed JSON), created_at
    """
    cursor = await db.execute(
        "SELECT extraction_type, content, metadata, created_at "
        "FROM document_extractions WHERE document_id = ? ORDER BY extraction_type",
        (document_id,),
    )
    rows = await cursor.fetchall()
    cols = [d[0] for d in cursor.description]

    results = []
    for row in rows:
        d = dict(zip(cols, row))
        # Parse JSON content back
        try:
            d["content"] = json.loads(d["content"])
        except (json.JSONDecodeError, TypeError):
            pass
        try:
            d["metadata"] = json.loads(d["metadata"]) if d.get("metadata") else {}
        except (json.JSONDecodeError, TypeError):
            d["metadata"] = {}
        results.append(d)

    return results
