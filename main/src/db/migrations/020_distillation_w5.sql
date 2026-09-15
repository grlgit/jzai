-- 知识蒸馏 W5：实操层工具结构化 + 评分者权重
-- 工具类产物的结构化规格（清单项/表单字段/评分维度等），供 CoWorker 程序化套用
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS structured JSONB;

-- 评分者权重（资深销售权重更高；缺省 1.0）
CREATE TABLE IF NOT EXISTS jz_distill_rater_weights (
  user_id    TEXT PRIMARY KEY,
  weight     REAL NOT NULL DEFAULT 1.0,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
