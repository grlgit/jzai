-- 029: Onboarding State Management
-- 添加首次使用引导状态管理支持

-- 扩展分配表，添加引导状态字段
ALTER TABLE jz_coworker_assignments
  ADD COLUMN IF NOT EXISTS onboarding_state JSONB DEFAULT '{"completed": false, "step": 0, "skipped": [], "profileCompleted": false, "startedAt": null, "lastAt": null}';

-- onboarding_state 结构说明：
-- {
--   "completed": false,              // 引导是否完成
--   "step": 2,                      // 当前步骤（0-4）
--   "skipped": ["wechat"],          // 跳过的步骤列表
--   "profileCompleted": false,       // 个人信息是否完成
--   "startedAt": "2026-01-15T10:00:00Z",  // 引导开始时间
--   "lastAt": "2026-01-15T10:05:00Z"     // 最后更新时间
-- }

-- 注释
COMMENT ON COLUMN jz_coworker_assignments.onboarding_state IS '首次使用引导状态：记录CoWorker激活后的引导进度（完成状态、当前步骤、跳过步骤等）';

-- 索引（用于查询需要引导的分配）
CREATE INDEX IF NOT EXISTS idx_cwa_onboarding ON jz_coworker_assignments((onboarding_state->>'completed')) WHERE (onboarding_state->>'completed') = 'false';
