-- 裸表名即可：search_path 已固定到本应用 schema
CREATE TABLE IF NOT EXISTS fa_notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
