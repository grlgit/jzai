-- 040_app_service_events.sql
-- PLAT-016：伴随服务（companion service）事件审计。
-- 记录拉起/停止/崩溃/重启/健康失败与恢复，供运维审计与排障。

CREATE TABLE IF NOT EXISTS jz_app_service_events (
  id          BIGSERIAL PRIMARY KEY,
  app_id      TEXT NOT NULL,
  service_id  TEXT NOT NULL,
  event       TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jz_app_service_events_app
  ON jz_app_service_events (app_id, created_at DESC);
