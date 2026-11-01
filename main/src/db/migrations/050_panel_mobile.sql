-- 050: Panel mobile config (P4 移动端 APP 兼容, docs/rework-2026H2/design-p4-mobile.md §3)

ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS mobile_config JSONB;
