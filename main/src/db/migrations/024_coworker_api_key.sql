-- 024: CoWorker API Key Authentication
-- Add API key for CoWorker instances to authenticate LLM proxy calls
-- Replaces short-lived JWT tokens with long-lived API keys

ALTER TABLE jz_coworker_assignments
  ADD COLUMN IF NOT EXISTS api_key VARCHAR(100) UNIQUE,
  ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS api_key_revoked_at TIMESTAMPTZ;

-- Index for API key lookup (critical for performance)
CREATE INDEX IF NOT EXISTS idx_cwa_api_key ON jz_coworker_assignments(api_key);

-- Generate API keys for existing assignments that don't have one
-- Uses assignment ID + timestamp to ensure uniqueness and avoid collisions
-- Safe for re-run (only updates where api_key IS NULL)
UPDATE jz_coworker_assignments
SET api_key = 'jw_' || substr(md5(id || '-' || EXTRACT(EPOCH FROM NOW)::text || '-' || random()::text), 1, 64),
    api_key_created_at = NOW()
WHERE api_key IS NULL;
