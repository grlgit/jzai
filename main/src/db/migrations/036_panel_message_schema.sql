-- Migration 036: persist panel messageSchema path.
-- App panels declare a message validator module (ESM) that the frontend
-- dynamically imports to normalize _panel_output payloads for this panel.

ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS message_schema TEXT;
