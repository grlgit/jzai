-- 051: 一级菜单导航权限（nav:*）上线。
-- 技能/连接/智能体/应用/数据仪表/设置六个内置面板从"permission 为 NULL 或绑定 sys:admin/cfg:automation"
-- 改为独立的 nav:* 权限，使【权限配置】可单独授予/收回。
-- 迁移目标：行为不变——把"此前对所有人可见"的菜单权限（nav:settings / nav:apps / nav:dashboard）
-- 回填给所有存量角色；技能/连接/智能体维持"仅管理员可见"（不回填，可手动授予）。

UPDATE jz_roles SET permissions = array_append(permissions, 'nav:settings')
  WHERE NOT ('nav:settings' = ANY(permissions));
UPDATE jz_roles SET permissions = array_append(permissions, 'nav:apps')
  WHERE NOT ('nav:apps' = ANY(permissions));
UPDATE jz_roles SET permissions = array_append(permissions, 'nav:dashboard')
  WHERE NOT ('nav:dashboard' = ANY(permissions));

-- 面板表权限列随 panel.service.ts 内置清单在启动时 ON CONFLICT 更新，本迁移无需改 jz_panels。
