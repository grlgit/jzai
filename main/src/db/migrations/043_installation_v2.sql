-- License v2: drop machine fingerprint dependency.
-- Instance identity is now the stable local row id (jz_installation.id),
-- shared with the website as jzw_installations.id.
ALTER TABLE jz_installation ALTER COLUMN machine_fingerprint DROP NOT NULL;
ALTER TABLE jz_installation DROP CONSTRAINT IF EXISTS jz_installation_machine_fingerprint_key;
