-- 013: Knowledge Base Restructure
-- Unified category tree (directory + taxonomy + permission), organization structure,
-- and KB core tables migrated from llm_wiki SQLite to main platform PostgreSQL.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Organization Structure (moved from llm_wiki)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS jz_departments (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    parent_id TEXT REFERENCES jz_departments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    head_user_id TEXT REFERENCES jz_users(id) ON DELETE SET NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jz_department_members (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    department_id TEXT NOT NULL REFERENCES jz_departments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES jz_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'editor', 'head')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(department_id, user_id)
);

CREATE TABLE IF NOT EXISTS jz_workgroups (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jz_workgroup_members (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    workgroup_id TEXT NOT NULL REFERENCES jz_workgroups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES jz_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(workgroup_id, user_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Unified Knowledge Category Tree (replaces taxonomy + directory_meta + directory_permissions)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS jz_kb_categories (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    parent_id TEXT REFERENCES jz_kb_categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    tags TEXT[] DEFAULT '{}',
    template TEXT,
    description TEXT,
    icon TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(parent_id, slug)
);

CREATE TABLE IF NOT EXISTS jz_kb_category_access (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    category_id TEXT NOT NULL REFERENCES jz_kb_categories(id) ON DELETE CASCADE,
    grantee_type TEXT NOT NULL CHECK (grantee_type IN ('department', 'workgroup', 'user')),
    grantee_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(category_id, grantee_type, grantee_id)
);

CREATE TABLE IF NOT EXISTS jz_kb_synonyms (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    keyword TEXT NOT NULL UNIQUE,
    synonyms TEXT[] NOT NULL DEFAULT '{}'
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. KB Core Tables (migrated from llm_wiki SQLite)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS jz_kb_documents (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    filename TEXT NOT NULL,
    title TEXT,
    path TEXT DEFAULT '/' NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('wiki', 'source', 'asset')),
    file_type TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','draft','review','archived','failed')),
    sensitivity TEXT DEFAULT 'public',
    page_count INTEGER,
    content TEXT,
    tags TEXT[] DEFAULT '{}',
    date TEXT,
    metadata JSONB,
    error_message TEXT,
    version INTEGER DEFAULT 0,
    parser TEXT,
    content_hash TEXT,
    mtime_ns BIGINT,
    last_indexed_at TIMESTAMPTZ,
    stale_since TIMESTAMPTZ,
    document_number INTEGER,
    category_id TEXT REFERENCES jz_kb_categories(id) ON DELETE SET NULL,
    owner_user_id TEXT REFERENCES jz_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jz_kb_document_chunks (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    document_id TEXT NOT NULL REFERENCES jz_kb_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    page INTEGER,
    start_char INTEGER,
    token_count INTEGER NOT NULL,
    header_breadcrumb TEXT,
    embedding BYTEA,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS jz_kb_document_pages (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    document_id TEXT NOT NULL REFERENCES jz_kb_documents(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    content TEXT NOT NULL,
    elements TEXT,
    UNIQUE(document_id, page)
);

CREATE TABLE IF NOT EXISTS jz_kb_document_references (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    source_document_id TEXT NOT NULL REFERENCES jz_kb_documents(id) ON DELETE CASCADE,
    target_document_id TEXT NOT NULL REFERENCES jz_kb_documents(id) ON DELETE CASCADE,
    reference_type TEXT NOT NULL CHECK (reference_type IN ('cites', 'links_to')),
    page INTEGER,
    UNIQUE(source_document_id, target_document_id, reference_type)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Knowledge Extraction & Entity Graph
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS jz_kb_extractions (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    document_id TEXT NOT NULL REFERENCES jz_kb_documents(id) ON DELETE CASCADE,
    extraction_type TEXT NOT NULL CHECK (extraction_type IN ('entities','facts','categories','summary')),
    content JSONB NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, extraction_type)
);

CREATE TABLE IF NOT EXISTS jz_kb_entities (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('person','org','product','concept','location','other')),
    description TEXT DEFAULT '',
    mention_count INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, entity_type)
);

CREATE TABLE IF NOT EXISTS jz_kb_entity_doc_links (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    entity_id TEXT NOT NULL REFERENCES jz_kb_entities(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES jz_kb_documents(id) ON DELETE CASCADE,
    UNIQUE(entity_id, document_id)
);

CREATE TABLE IF NOT EXISTS jz_kb_entity_relations (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    source_entity_id TEXT NOT NULL REFERENCES jz_kb_entities(id) ON DELETE CASCADE,
    target_entity_id TEXT NOT NULL REFERENCES jz_kb_entities(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    source_document_id TEXT REFERENCES jz_kb_documents(id) ON DELETE SET NULL,
    UNIQUE(source_entity_id, target_entity_id, relation_type)
);

CREATE TABLE IF NOT EXISTS jz_kb_conflicts (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    conflict_type TEXT NOT NULL CHECK (conflict_type IN ('duplicate','contradiction','outdated')),
    description TEXT NOT NULL,
    doc_a_id TEXT REFERENCES jz_kb_documents(id) ON DELETE CASCADE,
    doc_b_id TEXT REFERENCES jz_kb_documents(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Full-Text Search (pg_trgm replaces SQLite FTS5)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Indexes
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_kb_chunks_content_trgm ON jz_kb_document_chunks USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kb_documents_path ON jz_kb_documents(path);
CREATE INDEX IF NOT EXISTS idx_kb_documents_status ON jz_kb_documents(status);
CREATE INDEX IF NOT EXISTS idx_kb_documents_category ON jz_kb_documents(category_id);
CREATE INDEX IF NOT EXISTS idx_kb_documents_owner ON jz_kb_documents(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON jz_kb_document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_refs_source ON jz_kb_document_references(source_document_id);
CREATE INDEX IF NOT EXISTS idx_kb_refs_target ON jz_kb_document_references(target_document_id);
CREATE INDEX IF NOT EXISTS idx_kb_extractions_doc ON jz_kb_extractions(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_entities_name ON jz_kb_entities(name);
CREATE INDEX IF NOT EXISTS idx_kb_category_access_cat ON jz_kb_category_access(category_id);
CREATE INDEX IF NOT EXISTS idx_dept_members_user ON jz_department_members(user_id);
CREATE INDEX IF NOT EXISTS idx_dept_members_dept ON jz_department_members(department_id);
CREATE INDEX IF NOT EXISTS idx_wg_members_user ON jz_workgroup_members(user_id);
CREATE INDEX IF NOT EXISTS idx_wg_members_wg ON jz_workgroup_members(workgroup_id);
CREATE INDEX IF NOT EXISTS idx_departments_parent ON jz_departments(parent_id);
CREATE INDEX IF NOT EXISTS idx_kb_categories_parent ON jz_kb_categories(parent_id);
