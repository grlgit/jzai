-- Migration 045: APP 订阅 License 与包签名
-- jz_installed_apps 增加订阅 License / 包完整性字段；status 枚举扩展 license_expired

ALTER TABLE jz_installed_apps
  ADD COLUMN IF NOT EXISTS license_blob TEXT,
  ADD COLUMN IF NOT EXISTS license_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS package_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS signature_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- status 枚举扩展：license_expired（订阅 License 到期失效，APP 不可用）
ALTER TABLE jz_installed_apps DROP CONSTRAINT IF EXISTS jz_installed_apps_status_check;
ALTER TABLE jz_installed_apps
  ADD CONSTRAINT jz_installed_apps_status_check
  CHECK (status IN ('installing','active','failed','uninstalling','uninstalled','upgrading','license_expired'));
