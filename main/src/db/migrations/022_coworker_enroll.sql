-- 018: CoWorker Windows App enrollment tracking
-- Add fields to track app activation/enrollment for Windows native app

ALTER TABLE jz_coworker_assignments
  ADD COLUMN IF NOT EXISTS enroll_token VARCHAR(100) UNIQUE,
  ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enroll_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enroll_ip VARCHAR(50),
  ADD COLUMN IF NOT EXISTS enroll_user_agent VARCHAR(500);

-- Index for token lookup
CREATE INDEX IF NOT EXISTS idx_cwa_enroll_token ON jz_coworker_assignments(enroll_token);
