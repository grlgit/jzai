-- Migration 034: Remove residual 'dt:use' permission from role arrays.
-- The dimensionTuner panel is now provided by the dimension-tuner app package
-- and uses app-level grants instead of the platform 'dt:use' permission.
-- This cleans up any permissions arrays that still contain the obsolete value.

UPDATE jz_roles
SET permissions = array_remove(permissions, 'dt:use')
WHERE 'dt:use' = ANY(permissions);
