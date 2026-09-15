-- Add license_blob column for encrypted license storage
ALTER TABLE jz_installation ADD COLUMN IF NOT EXISTS license_blob TEXT;
