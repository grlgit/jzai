-- 010: Setup lifecycle tracking for first-run initialization wizard

-- Add setup phase tracking to installation table
ALTER TABLE jz_installation ADD COLUMN IF NOT EXISTS setup_phase TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE jz_installation ADD COLUMN IF NOT EXISTS needs_guided_config BOOLEAN NOT NULL DEFAULT TRUE;

-- Add password-changed flag for forced password change on first login
ALTER TABLE jz_users ADD COLUMN IF NOT EXISTS password_changed BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: existing deployments are fully initialized (no wizard needed)
UPDATE jz_installation SET setup_phase = 'complete', needs_guided_config = FALSE
  WHERE license_blob IS NOT NULL;
UPDATE jz_users SET password_changed = TRUE;
