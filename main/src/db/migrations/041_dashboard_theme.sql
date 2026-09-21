-- Dashboard visual theme: 'light' (default, current style) | 'dark' (大屏/反白风格)
ALTER TABLE jz_dashboards ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'light';
