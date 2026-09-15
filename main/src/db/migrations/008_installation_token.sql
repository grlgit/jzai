-- Rename api_key to installation_token (clearer semantics)
-- Drop website_customer_id (no longer needed with auto-registration)
ALTER TABLE jz_installation RENAME COLUMN api_key TO installation_token;
ALTER TABLE jz_installation DROP COLUMN IF EXISTS website_customer_id;
