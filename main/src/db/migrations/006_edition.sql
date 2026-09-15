-- Edition & Installation tracking
CREATE TABLE IF NOT EXISTS jz_installation (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  machine_fingerprint TEXT UNIQUE NOT NULL,
  edition TEXT NOT NULL DEFAULT 'community',
  company_name TEXT NOT NULL,
  contact_person TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  website_customer_id TEXT,
  api_key TEXT,
  credits_balance NUMERIC DEFAULT 0,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  last_sync TIMESTAMPTZ
);
