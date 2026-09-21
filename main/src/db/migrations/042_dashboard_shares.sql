-- Dashboard sharing: creator 可将仪表盘分享给其他用户（只读）
CREATE TABLE IF NOT EXISTS jz_dashboard_shares (
  dashboard_id TEXT NOT NULL REFERENCES jz_dashboards(id) ON DELETE CASCADE,
  owner_id     TEXT NOT NULL,
  shared_with  TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (dashboard_id, shared_with)
);
CREATE INDEX IF NOT EXISTS idx_dashboard_shares_user ON jz_dashboard_shares(shared_with);
