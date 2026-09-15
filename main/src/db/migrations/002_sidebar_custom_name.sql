-- 002: Add custom_name column to jz_user_sidebar for user-customizable panel names
ALTER TABLE jz_user_sidebar ADD COLUMN IF NOT EXISTS custom_name TEXT;
