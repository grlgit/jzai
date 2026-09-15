-- 003: Add custom_icon column to jz_user_sidebar
ALTER TABLE jz_user_sidebar ADD COLUMN IF NOT EXISTS custom_icon TEXT;
