-- 001: Initial schema
-- Extracted from inline db.service.ts initSchema()

-- Users
CREATE TABLE IF NOT EXISTS jz_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role_id TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- Roles
CREATE TABLE IF NOT EXISTS jz_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  permissions TEXT[] DEFAULT '{}',
  is_system BOOLEAN DEFAULT FALSE
);

-- Analytics events
CREATE TABLE IF NOT EXISTS jz_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  user_id TEXT,
  conversation_id TEXT,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Feedback
CREATE TABLE IF NOT EXISTS jz_feedbacks (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT DEFAULT 'anonymous',
  rating TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions
CREATE TABLE IF NOT EXISTS jz_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_type TEXT NOT NULL DEFAULT 'main',
  title TEXT,
  skill_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages
CREATE TABLE IF NOT EXISTS jz_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Memories (compressed summaries)
CREATE TABLE IF NOT EXISTS jz_memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  original_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Panel catalog
CREATE TABLE IF NOT EXISTS jz_panels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  permission TEXT,
  is_builtin BOOLEAN DEFAULT FALSE,
  sort_order INT DEFAULT 99
);

-- User sidebar layout
CREATE TABLE IF NOT EXISTS jz_user_sidebar (
  user_id TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  visible BOOLEAN DEFAULT TRUE,
  group_name TEXT DEFAULT '',
  sort_order INT DEFAULT 99,
  PRIMARY KEY (user_id, panel_id)
);

-- User shortcuts
CREATE TABLE IF NOT EXISTS jz_shortcuts (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🔗',
  type TEXT NOT NULL DEFAULT 'panel',
  target TEXT NOT NULL,
  sort_order INT DEFAULT 99,
  PRIMARY KEY (user_id, id)
);

-- Knowledge Base tables
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  slug TEXT,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL,
  user_id TEXT,
  filename TEXT NOT NULL,
  title TEXT,
  path TEXT DEFAULT '/',
  relative_path TEXT,
  source_kind TEXT DEFAULT 'source',
  file_type TEXT,
  file_size INTEGER DEFAULT 0,
  document_number INTEGER,
  status TEXT DEFAULT 'ready',
  page_count INTEGER DEFAULT 0,
  content TEXT,
  tags TEXT[] DEFAULT '{}',
  date TEXT,
  metadata JSONB DEFAULT '{}',
  error_message TEXT,
  version INTEGER DEFAULT 0,
  parser TEXT,
  content_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_pages (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  content TEXT NOT NULL,
  elements JSONB,
  UNIQUE(document_id, page)
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  knowledge_base_id TEXT,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  page INTEGER,
  start_char INTEGER,
  token_count INTEGER,
  header_breadcrumb TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS document_references (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL,
  target_document_id TEXT NOT NULL,
  knowledge_base_id TEXT,
  reference_type TEXT DEFAULT 'cites',
  page INTEGER,
  UNIQUE(source_document_id, target_document_id, reference_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_docs_kb ON documents(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_docs_path ON documents(knowledge_base_id, path);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_refs_source ON document_references(source_document_id);
CREATE INDEX IF NOT EXISTS idx_refs_target ON document_references(target_document_id);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON jz_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_user ON jz_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON jz_feedbacks(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON jz_sessions(user_id, agent_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session ON jz_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_session ON jz_memories(session_id, created_at);

-- Seed default knowledge base
INSERT INTO knowledge_bases (id, name, slug, description)
VALUES ('default', '企业心智', 'default', '默认企业心智')
ON CONFLICT (id) DO NOTHING;
