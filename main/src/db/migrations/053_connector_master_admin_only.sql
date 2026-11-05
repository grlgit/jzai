-- 连接大师（connector_master）仅管理员可见：
-- 普通用户此前可经「连接」面板配对（sidebar agentId）与其对话修改连接。
-- 置 default_visibility='none' 后，普通用户无 meta 兜底可见性，需显式 grant 才可见；
-- admin 由 ResourceAccessService 硬例外放行，不受影响。
INSERT INTO jz_resource_meta (resource_type, resource_id, scope, builtin, default_visibility)
VALUES ('agent', 'connector_master', 'global', TRUE, 'none')
ON CONFLICT (resource_type, resource_id)
DO UPDATE SET default_visibility = 'none', updated_at = NOW();
