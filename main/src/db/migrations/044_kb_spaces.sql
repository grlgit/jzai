-- 044: KB Spaces (知识空间)
-- 引入知识空间模型：normal(enterprise/personal) 与 app 两类空间，分类树与文档按空间隔离。
-- 修订（2026-10-04）：① 取消 proj-（项目）空间类型（与 APP 空间同质）；② 不做旧数据迁移，
-- 存量行一律兜底挂 ent-default，磁盘旧文件弃置原位。

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Spaces table
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS jz_kb_spaces (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('normal','app')),
    subtype TEXT CHECK (subtype IN ('enterprise','personal')),
    owner_app_id TEXT,
    owner_user_id TEXT REFERENCES jz_users(id) ON DELETE SET NULL,
    description TEXT,
    config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_spaces_owner_app ON jz_kb_spaces(owner_app_id);
CREATE INDEX IF NOT EXISTS idx_kb_spaces_owner_user ON jz_kb_spaces(owner_user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. space_id columns
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE jz_kb_categories ADD COLUMN IF NOT EXISTS space_id TEXT REFERENCES jz_kb_spaces(id) ON DELETE CASCADE;
ALTER TABLE jz_kb_documents  ADD COLUMN IF NOT EXISTS space_id TEXT REFERENCES jz_kb_spaces(id) ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Seed enterprise space + 兜底回填（不做 legacy 拆分，用户确认不迁移旧数据）
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO jz_kb_spaces (name, slug, type, subtype, description)
VALUES ('企业知识库', 'ent-default', 'normal', 'enterprise', '默认企业空间')
ON CONFLICT (slug) DO NOTHING;

UPDATE jz_kb_documents
SET space_id = (SELECT id FROM jz_kb_spaces WHERE slug = 'ent-default')
WHERE space_id IS NULL;

UPDATE jz_kb_categories
SET space_id = (SELECT id FROM jz_kb_spaces WHERE slug = 'ent-default')
WHERE space_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Uniqueness & indexes（space 维度）
-- ═══════════════════════════════════════════════════════════════════════════════

-- relative_path 原全局唯一 → 改为空间内唯一
ALTER TABLE jz_kb_documents DROP CONSTRAINT IF EXISTS jz_kb_documents_relative_path_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_documents_space_relpath
    ON jz_kb_documents (space_id, relative_path);
CREATE INDEX IF NOT EXISTS idx_kb_documents_space ON jz_kb_documents(space_id);

-- categories.path 原全局唯一 → 改为空间内唯一
ALTER TABLE jz_kb_categories DROP CONSTRAINT IF EXISTS jz_kb_categories_path_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_categories_space_path
    ON jz_kb_categories (space_id, path);
CREATE INDEX IF NOT EXISTS idx_kb_categories_space ON jz_kb_categories(space_id);

-- 回填完成后设为 NOT NULL
ALTER TABLE jz_kb_documents ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE jz_kb_categories ALTER COLUMN space_id SET NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. 主台"企业心智"面板入口移除（U10：功能将全部迁入企业WIKI APP）
-- ═══════════════════════════════════════════════════════════════════════════════

DELETE FROM jz_panels WHERE id = 'kb';
