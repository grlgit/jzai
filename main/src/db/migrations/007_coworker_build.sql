-- Track CoWorker build status
ALTER TABLE jz_coworkers ADD COLUMN IF NOT EXISTS build_version INT DEFAULT 0;
ALTER TABLE jz_coworkers ADD COLUMN IF NOT EXISTS config_version INT DEFAULT 1;
ALTER TABLE jz_coworkers ADD COLUMN IF NOT EXISTS last_build_at TIMESTAMPTZ;
