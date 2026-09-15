"""Lightweight embedding service for semantic search.

Calls an external embedding API (Ollama or OpenAI-compatible) to generate
vector embeddings for document chunks. No heavy ML dependencies required.

When no embedding endpoint is configured, semantic search is silently disabled
and the system falls back to FTS5 keyword search.
"""

import json
import logging
import struct
from pathlib import Path

import httpx

from config import settings

logger = logging.getLogger(__name__)

# Embedding config from environment
EMBED_ENDPOINT = getattr(settings, 'EMBED_ENDPOINT', '') or ''
EMBED_MODEL = getattr(settings, 'EMBED_MODEL', 'bge-m3')
EMBED_DIM = int(getattr(settings, 'EMBED_DIM', 1024))


def is_available() -> bool:
    """Check if embedding service is configured."""
    return bool(EMBED_ENDPOINT)


async def generate_embeddings(texts: list[str]) -> list[list[float]] | None:
    """Generate embeddings for a batch of texts.

    Returns list of float vectors, or None if service unavailable.
    Silently returns None on errors (fallback to keyword search).
    """
    if not EMBED_ENDPOINT:
        return None

    try:
        # Try OpenAI-compatible /v1/embeddings endpoint first
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
            resp = await client.post(
                f"{EMBED_ENDPOINT}/v1/embeddings",
                json={"model": EMBED_MODEL, "input": texts},
            )
            resp.raise_for_status()
            data = resp.json()

        embeddings = [item["embedding"] for item in sorted(data["data"], key=lambda x: x["index"])]
        return embeddings
    except Exception as e:
        logger.debug(f"Embedding generation failed: {e}")
        return None


async def generate_embedding(text: str) -> list[float] | None:
    """Generate embedding for a single text."""
    result = await generate_embeddings([text])
    return result[0] if result else None


def embedding_to_blob(vec: list[float]) -> bytes:
    """Pack float vector to compact binary blob for SQLite storage."""
    return struct.pack(f'{len(vec)}f', *vec)


def blob_to_embedding(blob: bytes) -> list[float]:
    """Unpack binary blob back to float vector."""
    n = len(blob) // 4
    return list(struct.unpack(f'{n}f', blob))


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)
