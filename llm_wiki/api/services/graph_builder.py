"""Knowledge graph builder — processes extraction results into entity-level graph.

Builds on top of the document-level reference graph (document_references)
by adding entity nodes and entity-document links from LLM extraction results.

Also detects potential knowledge conflicts (duplicate facts, contradictions)
across documents.
"""

import json
import logging
import uuid

logger = logging.getLogger(__name__)


async def build_entity_graph(db, document_id: str) -> dict:
    """Process a document's extractions into entity graph nodes and links.

    Reads the 'entities' extraction for the given document,
    upserts into knowledge_entities, and creates entity_document_links.

    Returns:
        {"entities_added": int, "links_created": int}
    """
    # Get entities extraction
    cursor = await db.execute(
        "SELECT content FROM document_extractions "
        "WHERE document_id = ? AND extraction_type = 'entities'",
        (document_id,),
    )
    row = await cursor.fetchone()
    if not row:
        return {"entities_added": 0, "links_created": 0}

    try:
        entities = json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return {"entities_added": 0, "links_created": 0}

    if not isinstance(entities, list):
        return {"entities_added": 0, "links_created": 0}

    entities_added = 0
    links_created = 0

    for ent in entities:
        name = (ent.get("name") or "").strip()
        etype = (ent.get("type") or "other").strip().lower()
        desc = (ent.get("description") or "").strip()

        if not name:
            continue
        if etype not in ("person", "org", "product", "concept", "location", "other"):
            etype = "other"

        # Upsert entity
        ent_id = uuid.uuid4().hex
        await db.execute(
            "INSERT INTO knowledge_entities (id, name, entity_type, description, first_seen_doc_id) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(name, entity_type) DO UPDATE SET "
            "mention_count = mention_count + 1, "
            "updated_at = datetime('now'), "
            "description = CASE WHEN length(excluded.description) > length(knowledge_entities.description) "
            "THEN excluded.description ELSE knowledge_entities.description END",
            (ent_id, name, etype, desc, document_id),
        )

        # Resolve the actual entity ID (may differ if it already existed)
        cursor = await db.execute(
            "SELECT id FROM knowledge_entities WHERE name = ? AND entity_type = ?",
            (name, etype),
        )
        actual = await cursor.fetchone()
        if not actual:
            continue
        actual_id = actual[0]

        if actual_id == ent_id:
            entities_added += 1

        # Create entity-document link
        link_id = uuid.uuid4().hex
        try:
            await db.execute(
                "INSERT INTO entity_document_links (id, entity_id, document_id) "
                "VALUES (?, ?, ?) ON CONFLICT(entity_id, document_id) DO NOTHING",
                (link_id, actual_id, document_id),
            )
            links_created += 1
        except Exception:
            pass  # Duplicate link, ignore

    await db.commit()
    logger.info("Entity graph built for doc %s: %d entities, %d links",
                document_id[:8], entities_added, links_created)
    return {"entities_added": entities_added, "links_created": links_created}


async def detect_conflicts(db, document_id: str) -> dict:
    """Detect knowledge conflicts between a document's facts and existing facts.

    Compares the 'facts' extraction of the given document against facts
    from other documents that share common entities. Flags potential
    duplicates and contradictions.

    Returns:
        {"conflicts_found": int}
    """
    # Get this document's facts
    cursor = await db.execute(
        "SELECT content FROM document_extractions "
        "WHERE document_id = ? AND extraction_type = 'facts'",
        (document_id,),
    )
    row = await cursor.fetchone()
    if not row:
        return {"conflicts_found": 0}

    try:
        new_facts = json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return {"conflicts_found": 0}

    if not isinstance(new_facts, list) or len(new_facts) == 0:
        return {"conflicts_found": 0}

    # Find documents sharing entities with this document
    cursor = await db.execute(
        "SELECT DISTINCT edl2.document_id FROM entity_document_links edl1 "
        "JOIN entity_document_links edl2 ON edl1.entity_id = edl2.entity_id "
        "WHERE edl1.document_id = ? AND edl2.document_id != ?",
        (document_id, document_id),
    )
    related_doc_ids = [r[0] for r in await cursor.fetchall()]

    if not related_doc_ids:
        return {"conflicts_found": 0}

    # Get facts from related documents
    placeholders = ",".join("?" for _ in related_doc_ids)
    cursor = await db.execute(
        f"SELECT document_id, content FROM document_extractions "
        f"WHERE document_id IN ({placeholders}) AND extraction_type = 'facts'",
        related_doc_ids,
    )
    existing_rows = await cursor.fetchall()

    conflicts_found = 0

    for doc_b_id, facts_json in existing_rows:
        try:
            existing_facts = json.loads(facts_json)
        except (json.JSONDecodeError, TypeError):
            continue

        if not isinstance(existing_facts, list):
            continue

        # Simple duplicate/conflict detection via substring matching
        for new_fact in new_facts:
            new_claim = (new_fact.get("claim") or "").strip()
            if len(new_claim) < 10:
                continue

            for old_fact in existing_facts:
                old_claim = (old_fact.get("claim") or "").strip()
                if len(old_claim) < 10:
                    continue

                similarity = _text_similarity(new_claim, old_claim)

                if similarity > 0.8:
                    # Very similar — likely duplicate
                    conflict_id = uuid.uuid4().hex
                    try:
                        await db.execute(
                            "INSERT INTO knowledge_conflicts "
                            "(id, conflict_type, description, doc_a_id, doc_b_id) "
                            "VALUES (?, 'duplicate', ?, ?, ?)",
                            (conflict_id,
                             f"相似事实: [{new_claim[:80]}] vs [{old_claim[:80]}]",
                             document_id, doc_b_id),
                        )
                        conflicts_found += 1
                    except Exception:
                        pass  # Ignore if constraint fails

                elif similarity > 0.5 and _has_contradicting_terms(new_claim, old_claim):
                    # Moderate similarity but contradicting terms
                    conflict_id = uuid.uuid4().hex
                    try:
                        await db.execute(
                            "INSERT INTO knowledge_conflicts "
                            "(id, conflict_type, description, doc_a_id, doc_b_id) "
                            "VALUES (?, 'contradiction', ?, ?, ?)",
                            (conflict_id,
                             f"可能矛盾: [{new_claim[:80]}] vs [{old_claim[:80]}]",
                             document_id, doc_b_id),
                        )
                        conflicts_found += 1
                    except Exception:
                        pass

    if conflicts_found > 0:
        await db.commit()
        logger.info("Detected %d conflicts for doc %s", conflicts_found, document_id[:8])

    return {"conflicts_found": conflicts_found}


def _text_similarity(a: str, b: str) -> float:
    """Simple character-level Jaccard similarity for short texts."""
    if not a or not b:
        return 0.0
    # Use character bigrams for CJK-friendly comparison
    bigrams_a = {a[i:i+2] for i in range(len(a) - 1)}
    bigrams_b = {b[i:i+2] for i in range(len(b) - 1)}
    if not bigrams_a or not bigrams_b:
        return 0.0
    intersection = bigrams_a & bigrams_b
    union = bigrams_a | bigrams_b
    return len(intersection) / len(union)


def _has_contradicting_terms(a: str, b: str) -> bool:
    """Check if two claims contain contradicting numeric/negation patterns."""
    # Simple heuristic: different numbers in similar context
    import re
    nums_a = set(re.findall(r'\d+(?:\.\d+)?', a))
    nums_b = set(re.findall(r'\d+(?:\.\d+)?', b))
    if nums_a and nums_b and nums_a != nums_b:
        return True

    # Negation patterns
    neg_zh = {"不", "没有", "无", "非", "未"}
    a_has_neg = any(n in a for n in neg_zh)
    b_has_neg = any(n in b for n in neg_zh)
    if a_has_neg != b_has_neg:
        return True

    return False


async def get_entity_graph(db, kb_id: str = None) -> dict:
    """Return entity-level graph data for visualization.

    Returns:
        {"entities": [...], "relations": [...], "entity_doc_links": [...]}
    """
    # Entities
    cursor = await db.execute(
        "SELECT id, name, entity_type, description, mention_count, created_at "
        "FROM knowledge_entities ORDER BY mention_count DESC LIMIT 200"
    )
    cols = [d[0] for d in cursor.description]
    entities = [dict(zip(cols, r)) for r in await cursor.fetchall()]

    # Relations
    cursor = await db.execute(
        "SELECT kr.id, ke1.name as source_name, ke2.name as target_name, "
        "kr.relation_type, kr.source_entity_id, kr.target_entity_id "
        "FROM knowledge_relations kr "
        "JOIN knowledge_entities ke1 ON kr.source_entity_id = ke1.id "
        "JOIN knowledge_entities ke2 ON kr.target_entity_id = ke2.id "
        "LIMIT 500"
    )
    cols = [d[0] for d in cursor.description]
    relations = [dict(zip(cols, r)) for r in await cursor.fetchall()]

    # Entity-document links (top entities only)
    entity_ids = [e["id"] for e in entities[:50]]
    entity_doc_links = []
    if entity_ids:
        placeholders = ",".join("?" for _ in entity_ids)
        cursor = await db.execute(
            f"SELECT edl.entity_id, edl.document_id, d.title, d.filename, d.path "
            f"FROM entity_document_links edl "
            f"JOIN documents d ON edl.document_id = d.id "
            f"WHERE edl.entity_id IN ({placeholders})",
            entity_ids,
        )
        cols = [d[0] for d in cursor.description]
        entity_doc_links = [dict(zip(cols, r)) for r in await cursor.fetchall()]

    return {
        "entities": entities,
        "relations": relations,
        "entity_doc_links": entity_doc_links,
    }


async def get_conflicts(db, status: str = "open") -> list[dict]:
    """Return knowledge conflicts filtered by status.

    Returns list of conflict dicts with document info.
    """
    cursor = await db.execute(
        "SELECT kc.*, "
        "da.title as doc_a_title, da.filename as doc_a_filename, "
        "db2.title as doc_b_title, db2.filename as doc_b_filename "
        "FROM knowledge_conflicts kc "
        "LEFT JOIN documents da ON kc.doc_a_id = da.id "
        "LEFT JOIN documents db2 ON kc.doc_b_id = db2.id "
        "WHERE kc.status = ? ORDER BY kc.created_at DESC LIMIT 100",
        (status,),
    )
    cols = [d[0] for d in cursor.description]
    return [dict(zip(cols, r)) for r in await cursor.fetchall()]


async def resolve_conflict(db, conflict_id: str, resolution: str = "resolved") -> bool:
    """Mark a conflict as resolved or dismissed."""
    if resolution not in ("resolved", "dismissed"):
        return False
    cursor = await db.execute(
        "UPDATE knowledge_conflicts SET status = ?, resolved_at = datetime('now') "
        "WHERE id = ? AND status = 'open'",
        (resolution, conflict_id),
    )
    await db.commit()
    return cursor.rowcount > 0
