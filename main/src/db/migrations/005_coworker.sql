-- 005: CoWorker tables

-- CoWorker definitions (admin-created templates)
CREATE TABLE IF NOT EXISTS jz_coworkers (
  id TEXT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT DEFAULT '',
  avatar_url VARCHAR(500) DEFAULT '',
  soul TEXT DEFAULT '',
  model_level VARCHAR(20) DEFAULT 'default',
  tools JSONB DEFAULT '[]',
  skills JSONB DEFAULT '[]',
  mcp_servers JSONB DEFAULT '[]',
  work_scope TEXT DEFAULT '',
  config_overrides JSONB DEFAULT '{}',
  wechat_config JSONB DEFAULT '{}',
  kb_bindings JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'draft',
  created_by TEXT REFERENCES jz_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- CoWorker assignments (which employee uses which CoWorker)
CREATE TABLE IF NOT EXISTS jz_coworker_assignments (
  id TEXT PRIMARY KEY,
  coworker_id TEXT NOT NULL REFERENCES jz_coworkers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES jz_users(id) ON DELETE CASCADE,
  docker_tag VARCHAR(200) DEFAULT '',
  status VARCHAR(20) DEFAULT 'pending',
  last_seen TIMESTAMPTZ,
  config_version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(coworker_id, user_id)
);

-- CoWorker message logs (synced from OpenClaw)
CREATE TABLE IF NOT EXISTS jz_coworker_messages (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES jz_coworker_assignments(id) ON DELETE CASCADE,
  channel VARCHAR(50) DEFAULT 'web',
  direction VARCHAR(10) NOT NULL,
  content TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- CoWorker event logs
CREATE TABLE IF NOT EXISTS jz_coworker_events (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES jz_coworker_assignments(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cw_status ON jz_coworkers(status);
CREATE INDEX IF NOT EXISTS idx_cw_created_by ON jz_coworkers(created_by);
CREATE INDEX IF NOT EXISTS idx_cwa_coworker ON jz_coworker_assignments(coworker_id);
CREATE INDEX IF NOT EXISTS idx_cwa_user ON jz_coworker_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_cwm_assignment ON jz_coworker_messages(assignment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cwe_assignment ON jz_coworker_events(assignment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cwe_type ON jz_coworker_events(event_type, created_at);
