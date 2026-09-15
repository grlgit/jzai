-- 知识蒸馏（尤达大师）：问题树轮次扇出 + 结果分层（W1）
CREATE TABLE IF NOT EXISTS jz_distillation_runs (
  id              TEXT PRIMARY KEY,
  topic           TEXT NOT NULL,
  scope_constraint TEXT,                          -- agent 引导后确定的范围（自然语言）
  seed_facts      TEXT,                           -- 用户提供的已知事实/现状（种子+接地）
  breadth_n       INT  NOT NULL DEFAULT 8,        -- 颗粒度：每轮每节点生成的问题数
  max_rounds      INT  NOT NULL DEFAULT 3,        -- 颗粒度：递归轮数 d
  result_taxonomy JSONB NOT NULL DEFAULT '["原理","领域","现状","实操"]',
  grounding_mode  TEXT NOT NULL DEFAULT 'hybrid', -- hybrid | parametric | rag_only
  budget          JSONB NOT NULL DEFAULT '{}',    -- { maxNodes, maxTokens, maxCost }
  category_root   TEXT,                            -- 落地的专项库根路径，如 /wiki/专项/MOM软件销售/
  status          TEXT NOT NULL DEFAULT 'running', -- running | done | failed
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jz_distillation_nodes (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES jz_distillation_runs(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES jz_distillation_nodes(id) ON DELETE CASCADE,
  round         INT  NOT NULL,                    -- 第几轮生成（递归深度，1..d）
  question      TEXT NOT NULL,
  result_layer  TEXT,                             -- 结果层标签（原理/领域/现状/实操，与 round 无关）
  artifact_type TEXT,                             -- knowledge | skill | tool
  dedup_key     TEXT,                             -- 语义去重键（跨节点合并重复问题）
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | expanded | written | pruned | merged
  confidence    REAL,
  sources       JSONB NOT NULL DEFAULT '[]',
  doc_path      TEXT,                             -- 落地的 KB 文档路径
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_distill_nodes_run ON jz_distillation_nodes(run_id, status);
CREATE INDEX IF NOT EXISTS idx_distill_nodes_dedup ON jz_distillation_nodes(run_id, dedup_key);
