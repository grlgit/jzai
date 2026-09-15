-- LLM Wiki local index schema (SQLite + FTS5)
-- This is derived state — deletable and rebuildable from the workspace filesystem.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    title TEXT,
    path TEXT DEFAULT '/' NOT NULL,
    relative_path TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('wiki', 'source', 'asset')),
    file_type TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    document_number INTEGER,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'draft', 'review', 'archived', 'failed')),
    sensitivity TEXT DEFAULT 'public' CHECK (sensitivity IN ('public', 'internal', 'restricted')),
    page_count INTEGER,
    content TEXT,
    tags TEXT DEFAULT '[]',
    date TEXT,
    metadata TEXT,
    error_message TEXT,
    version INTEGER DEFAULT 0,
    parser TEXT,
    content_hash TEXT,
    mtime_ns INTEGER,
    last_indexed_at TEXT,
    stale_since TEXT,
    access_scope TEXT DEFAULT 'global',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(relative_path)
);

CREATE TABLE IF NOT EXISTS document_pages (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    content TEXT NOT NULL,
    elements TEXT,
    UNIQUE(document_id, page)
);

CREATE TABLE IF NOT EXISTS document_chunks (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    page INTEGER,
    start_char INTEGER,
    token_count INTEGER NOT NULL,
    header_breadcrumb TEXT,
    embedding BLOB,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS document_references (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    target_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    reference_type TEXT NOT NULL CHECK (reference_type IN ('cites', 'links_to')),
    page INTEGER,
    UNIQUE(source_document_id, target_document_id, reference_type)
);

-- ── Enterprise RBAC tables ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    language TEXT DEFAULT 'zh',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS org_members (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(org_id, email)
);

CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    head_email TEXT,
    subdirectory_attribute TEXT,
    subdirectory_label TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(org_id, slug)
);

CREATE TABLE IF NOT EXISTS department_members (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'editor')),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(department_id, email)
);

CREATE TABLE IF NOT EXISTS workgroups (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(org_id, slug)
);

CREATE TABLE IF NOT EXISTS workgroup_members (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    workgroup_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(workgroup_id, email)
);

CREATE TABLE IF NOT EXISTS directory_meta (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    path TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'department', 'personal', 'restricted')),
    department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
    owner_email TEXT,
    description TEXT,
    subdirectory_attribute TEXT,
    subdirectory_label TEXT,
    extra_config TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS directory_permissions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    directory_path TEXT NOT NULL,
    grantee_email TEXT,
    grantee_department_slug TEXT,
    grantee_workgroup_slug TEXT,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
    exclude_paths TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(directory_path, grantee_email),
    UNIQUE(directory_path, grantee_department_slug),
    UNIQUE(directory_path, grantee_workgroup_slug)
);

CREATE INDEX IF NOT EXISTS idx_org_members_email ON org_members(email);
CREATE INDEX IF NOT EXISTS idx_dept_members_email ON department_members(email);
CREATE INDEX IF NOT EXISTS idx_directory_meta_path ON directory_meta(path);
CREATE INDEX IF NOT EXISTS idx_directory_meta_scope ON directory_meta(scope);
CREATE INDEX IF NOT EXISTS idx_directory_permissions_path ON directory_permissions(directory_path);

-- ── Documents: add access_scope column ──────────────────────────────────────
-- access_scope is auto-derived from path during indexing:
--   'global'              — root files
--   'department:<slug>'   — department directory files
--   'personal:<email>'    — personal directory files
--   'restricted:<path>'   — restricted directory files
-- (added via ALTER TABLE if upgrading; included in CREATE TABLE for new installs)

-- FTS5 full-text search (replaces pgroonga)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content='document_chunks',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Keep FTS in sync with document_chunks
CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON document_chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE INDEX IF NOT EXISTS idx_documents_relative_path ON documents(relative_path);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
CREATE INDEX IF NOT EXISTS idx_documents_source_kind ON documents(source_kind);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_refs_source ON document_references(source_document_id);
CREATE INDEX IF NOT EXISTS idx_refs_target ON document_references(target_document_id);

-- ── Knowledge extraction results ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_extractions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    extraction_type TEXT NOT NULL CHECK (extraction_type IN ('entities', 'facts', 'categories', 'summary')),
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(document_id, extraction_type)
);

CREATE INDEX IF NOT EXISTS idx_extractions_doc ON document_extractions(document_id);
CREATE INDEX IF NOT EXISTS idx_extractions_type ON document_extractions(extraction_type);

-- ── Entity-level knowledge graph ────────────────────────────────────────────
-- Extends the document-level reference graph (document_references) with
-- entity-level nodes extracted from documents via LLM.

CREATE TABLE IF NOT EXISTS knowledge_entities (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'org', 'product', 'concept', 'location', 'other')),
    description TEXT DEFAULT '',
    first_seen_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    mention_count INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(name, entity_type)
);

CREATE TABLE IF NOT EXISTS entity_document_links (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    entity_id TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    relevance TEXT DEFAULT 'mentioned' CHECK (relevance IN ('primary', 'mentioned')),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(entity_id, document_id)
);

CREATE TABLE IF NOT EXISTS knowledge_relations (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source_entity_id TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
    target_entity_id TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(source_entity_id, target_entity_id, relation_type)
);

-- ── Knowledge conflicts / deduplication ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_conflicts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    conflict_type TEXT NOT NULL CHECK (conflict_type IN ('duplicate', 'contradiction', 'outdated')),
    description TEXT NOT NULL,
    doc_a_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    doc_b_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    entity_name TEXT,
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_entities_name ON knowledge_entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON knowledge_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entity_doc_entity ON entity_document_links(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_doc_doc ON entity_document_links(document_id);
CREATE INDEX IF NOT EXISTS idx_relations_source ON knowledge_relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON knowledge_relations(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_status ON knowledge_conflicts(status);
