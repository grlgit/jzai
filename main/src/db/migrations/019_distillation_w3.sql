-- 知识蒸馏 W3：内容验证回路（实战评分门）
-- 候选内容默认不生效；多人多轮打分达标才 promotion 发布进金库，低分回流优化。

-- 节点上挂生命周期与评分聚合态
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS lifecycle       TEXT NOT NULL DEFAULT 'candidate';
  -- candidate | validating | live | needs_fix | retired
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS version         INT  NOT NULL DEFAULT 1;
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS agg_score       REAL;
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS rating_count    INT  NOT NULL DEFAULT 0;
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS has_safety_flag BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS published_path  TEXT;          -- 生效后发布到金库的路径
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_distill_nodes_lifecycle ON jz_distillation_nodes(run_id, lifecycle);

-- 多人多轮评分明细（按 node_version 分桶——优化后是新内容，重新积累样本）
CREATE TABLE IF NOT EXISTS jz_distill_feedback (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES jz_distillation_nodes(id) ON DELETE CASCADE,
  node_version  INT  NOT NULL,
  rater_user_id TEXT NOT NULL,
  scenario      TEXT,                              -- 模拟/真实场景
  round         INT  NOT NULL DEFAULT 1,
  scores        JSONB NOT NULL,                    -- { accuracy, usability, effectiveness, safety } 各 1-5
  comment       TEXT,
  flagged_errors JSONB NOT NULL DEFAULT '[]',      -- [{ snippet, reason }]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_distill_fb_node ON jz_distill_feedback(node_id, node_version);
