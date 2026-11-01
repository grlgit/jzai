-- 049: APP MCP 暴露审批（P3, docs/rework-2026H2/design-p3-app-mcp.md §3）
-- 默认 FALSE：三方 APP 声明 mcpExposed 不自动生效，须 admin 审批；首方 APP 恒视为 allowed（无表行也通）。

CREATE TABLE IF NOT EXISTS jz_app_mcp_expose (
  app_id       TEXT PRIMARY KEY,
  allowed      BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ DEFAULT NOW(),
  note         TEXT
);
