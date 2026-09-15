-- Migration 032: Remove unused kb_admin and cw_admin system roles
-- These roles are no longer seeded; clean them up from existing databases.

-- Reassign any users still holding these obsolete roles to the default 'user' role
UPDATE jz_users SET role_id = 'user' WHERE role_id IN ('kb_admin', 'cw_admin');

-- Delete the obsolete system roles
DELETE FROM jz_roles WHERE id IN ('kb_admin', 'cw_admin');
