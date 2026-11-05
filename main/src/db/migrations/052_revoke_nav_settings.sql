-- 052: 设置面板（cfg）收敛为仅管理员可见（权限矩阵 T9 修复）。
-- nav:settings 不再默认授予普通用户角色；需要时由管理员在权限配置中显式授予。
-- 幂等：无论 051 是否已回填均收敛到"非 admin 角色无 nav:settings"。
UPDATE jz_roles SET permissions = array_remove(permissions, 'nav:settings') WHERE id <> 'admin';
