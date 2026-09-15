-- 019 CoWorker 会后分析：用 live 蒸馏工具规格(structured)程序化套用于会话记录
-- 把蒸馏出的 scorecard/checklist/script/form 当作评估量规，对一段对话打分/查覆盖，沉淀复盘报告。
CREATE TABLE IF NOT EXISTS jz_coworker_meeting_analysis (
  id             TEXT PRIMARY KEY,
  assignment_id  TEXT NOT NULL REFERENCES jz_coworker_assignments(id) ON DELETE CASCADE,
  coworker_id    TEXT NOT NULL REFERENCES jz_coworkers(id) ON DELETE CASCADE,
  window_from    TIMESTAMPTZ,                 -- 分析的会话窗口起
  window_to      TIMESTAMPTZ,                 -- 分析的会话窗口止
  message_count  INT  NOT NULL DEFAULT 0,     -- 纳入分析的消息条数
  specs_applied  JSONB NOT NULL DEFAULT '[]', -- [{ nodeId, title, kind }] 套用了哪些 live 工具规格
  result         JSONB NOT NULL DEFAULT '{}', -- 完整复盘报告（逐规格结果 + 总览 + 建议）
  overall_score  REAL,                        -- 0-100 综合得分（评分卡归一）
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cw_meeting_assignment ON jz_coworker_meeting_analysis(assignment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cw_meeting_coworker   ON jz_coworker_meeting_analysis(coworker_id, created_at DESC);
