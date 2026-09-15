-- 知识蒸馏 W2：候选内容留在蒸馏库（不进可检索金库，生效才发布）
-- 在节点上直接存生成的标题与正文（候选态），杜绝候选内容泄漏进企业心智检索
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS title   TEXT;
ALTER TABLE jz_distillation_nodes ADD COLUMN IF NOT EXISTS content TEXT;   -- 含 frontmatter 的完整候选文档

-- run 级总览与收尾标记
ALTER TABLE jz_distillation_runs  ADD COLUMN IF NOT EXISTS overview     TEXT;
ALTER TABLE jz_distillation_runs  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
