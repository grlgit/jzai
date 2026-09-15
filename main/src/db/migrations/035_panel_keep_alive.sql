-- Migration 035: persist panel keepAlive flag.
-- App panels may declare keepAlive (e.g. dimensionTuner) so the frontend keeps
-- them mounted after first visit instead of unmounting on tab switch.

ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS keep_alive BOOLEAN NOT NULL DEFAULT FALSE;
