-- P1 权限体系：DB 内资源（panel/app）的归属元数据回填。
-- 兼容性闸门：内置 panel 回填 default_visibility='all'（升级后可见性与升级前等价）；
-- APP 面板回填 'none'——其可见性沿用既有 jz_app_grants 判定（panel.service 双表 UNION），不受影响。
-- 文件系资源（agent/skill/connector/tool）由 ResourceMetaService.backfillOnBoot() 代码回填（启动时幂等）。

INSERT INTO jz_resource_meta (resource_type, resource_id, scope, source_app_id, builtin, default_visibility)
SELECT 'panel', p.id, 'global', p.source_app_id, COALESCE(p.is_builtin, FALSE),
       CASE WHEN p.source_app_id IS NULL THEN 'all' ELSE 'none' END
FROM jz_panels p
ON CONFLICT (resource_type, resource_id) DO NOTHING;

INSERT INTO jz_resource_meta (resource_type, resource_id, scope, source_app_id, builtin, default_visibility)
SELECT 'app', a.app_id, 'global', a.app_id, FALSE, 'none'
FROM jz_installed_apps a
WHERE a.status NOT IN ('uninstalled')
ON CONFLICT (resource_type, resource_id) DO NOTHING;
