-- 025: Workflow Transaction System
-- 实现工作流事务管理，支持状态持久化、补偿机制、失败回滚

-- 工作流事务表：记录工作流的整体状态和上下文
CREATE TABLE IF NOT EXISTS jz_workflow_transactions (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id VARCHAR(100) NOT NULL UNIQUE,
  assignment_id VARCHAR(36) NOT NULL REFERENCES jz_coworker_assignments(id) ON DELETE CASCADE,
  coworker_id VARCHAR(36) NOT NULL REFERENCES jz_coworkers(id) ON DELETE CASCADE,
  user_id VARCHAR(36) NOT NULL REFERENCES jz_users(id) ON DELETE CASCADE,

  -- 状态管理
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending: 已创建，等待执行
    -- running: 正在执行
    -- completed: 成功完成
    -- failed: 执行失败
    -- compensating: 正在执行补偿
    -- compensated: 补偿完成

  -- 工作流定义
  workflow_type VARCHAR(100) NOT NULL,
  description TEXT,

  -- 上下文数据（JSON）
  context JSONB DEFAULT '{}',
    -- 包含工作流执行过程中的共享数据
    -- 如：查询结果、生成的文件信息等

  -- 错误信息（失败时记录）
  error_message TEXT,
  error_stack TEXT,

  -- 计数器（用于乐观锁）
  version INTEGER NOT NULL DEFAULT 1,

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- 补偿相关
  compensating_at TIMESTAMPTZ,
  compensated_at TIMESTAMPTZ,
  compensation_reason TEXT
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_wft_workflow_id ON jz_workflow_transactions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wft_assignment_id ON jz_workflow_transactions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_wft_user_id ON jz_workflow_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wft_status ON jz_workflow_transactions(status);
CREATE INDEX IF NOT EXISTS idx_wft_created_at ON jz_workflow_transactions(created_at DESC);

-- 工作流步骤表：记录工作流中的每个步骤
CREATE TABLE IF NOT EXISTS jz_workflow_steps (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id VARCHAR(100) NOT NULL REFERENCES jz_workflow_transactions(workflow_id) ON DELETE CASCADE,

  -- 步骤标识
  step_number INTEGER NOT NULL,
  step_name VARCHAR(100) NOT NULL,
  tool_name VARCHAR(100) NOT NULL,

  -- 步骤状态
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending: 等待执行
    -- running: 正在执行
    -- completed: 成功完成
    -- failed: 执行失败
    -- skipped: 被跳过（前面步骤失败）
    -- compensating: 正在执行补偿
    -- compensated: 补偿完成

  -- 参数和结果
  input_params JSONB DEFAULT '{}',
  output_result JSONB,
  output_file_id VARCHAR(100),
    -- 对于生成文件的工具（如Excel、PDF），记录fileId

  -- 错误信息
  error_message TEXT,
  error_code VARCHAR(50),

  -- 补偿定义
  compensation_tool VARCHAR(100),
    -- 补偿工具名称
  compensation_params JSONB,
    -- 补偿参数模板（可引用步骤输出）

  -- 计数器（用于乐观锁）
  version INTEGER NOT NULL DEFAULT 1,

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- 唯一约束：同一工作流中步骤号唯一
  CONSTRAINT unique_step_per_workflow UNIQUE (workflow_id, step_number)
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_wfs_workflow_id ON jz_workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wfs_step_number ON jz_workflow_steps(workflow_id, step_number);
CREATE INDEX IF NOT EXISTS idx_wfs_status ON jz_workflow_steps(status);
CREATE INDEX IF NOT EXISTS idx_wfs_tool_name ON jz_workflow_steps(tool_name);

-- 工作流上下文附件表：记录工作流中生成的文件引用
CREATE TABLE IF NOT EXISTS jz_workflow_attachments (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id VARCHAR(100) NOT NULL REFERENCES jz_workflow_transactions(workflow_id) ON DELETE CASCADE,
  step_id VARCHAR(36) REFERENCES jz_workflow_steps(id) ON DELETE SET NULL,

  -- 文件信息
  file_id VARCHAR(100) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  file_type VARCHAR(50),
    -- excel, pdf, csv, etc.
  file_size BIGINT,

  -- 附件角色
  role VARCHAR(50) NOT NULL,
    -- input: 工具输入的文件
    -- output: 工具输出的文件
    -- attachment: 邮件附件

  -- 元数据
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_wfa_workflow_id ON jz_workflow_attachments(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wfa_step_id ON jz_workflow_attachments(step_id);
CREATE INDEX IF NOT EXISTS idx_wfa_role ON jz_workflow_attachments(role);

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_wft_updated_at
  BEFORE UPDATE ON jz_workflow_transactions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wfs_updated_at
  BEFORE UPDATE ON jz_workflow_steps
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 注释
COMMENT ON TABLE jz_workflow_transactions IS '工作流事务表：记录工作流的整体状态和上下文';
COMMENT ON TABLE jz_workflow_steps IS '工作流步骤表：记录工作流中的每个步骤';
COMMENT ON TABLE jz_workflow_attachments IS '工作流附件表：记录工作流中生成的文件引用';
