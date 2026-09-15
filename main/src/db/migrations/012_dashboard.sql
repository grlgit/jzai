-- User dashboards
CREATE TABLE IF NOT EXISTS jz_dashboards (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '我的仪表盘',
  description TEXT DEFAULT '',
  layout      JSONB DEFAULT '[]',
  is_default  BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dashboards_user ON jz_dashboards(user_id);

-- Dashboard widgets
CREATE TABLE IF NOT EXISTS jz_dashboard_widgets (
  id               TEXT PRIMARY KEY,
  dashboard_id     TEXT NOT NULL REFERENCES jz_dashboards(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  widget_type      TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  config           JSONB NOT NULL DEFAULT '{}',
  data_source      JSONB NOT NULL DEFAULT '{}',
  refresh_interval INT DEFAULT 0,
  cached_data      JSONB DEFAULT NULL,
  cached_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_widgets_dashboard ON jz_dashboard_widgets(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_widgets_user ON jz_dashboard_widgets(user_id);
