import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';

/**
 * Knowledge-base access control: resolve the set of category IDs a user may see.
 *
 * - Admins (sys:admin / kb:admin) receive the ADMIN_ALL sentinel, which disables
 *   filtering on the llm_wiki side.
 * - Other users receive a list of category IDs derived from direct user grants,
 *   department grants, and workgroup grants (recursive down the category tree).
 * - No grants -> empty list (fail-closed).
 */
@Injectable()
export class KbAccessService {
  constructor(private readonly db: DbService) {}

  /**
   * Return accessible category scopes for a user.
   * ADMIN_ALL means no filtering should be applied.
   */
  async getAccessibleScopesForUser(userId: string): Promise<string[] | 'ADMIN_ALL'> {
    const { rows } = await this.db.query(
      `SELECT u.role_id, r.permissions
       FROM jz_users u
       JOIN jz_roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [userId],
    );
    if (rows.length === 0) {
      return [];
    }

    const permissions: string[] = rows[0].permissions || [];
    if (permissions.includes('sys:admin') || permissions.includes('kb:admin')) {
      return 'ADMIN_ALL';
    }

    const result = await this.db.query(
      `
      WITH RECURSIVE accessible AS (
        SELECT DISTINCT category_id
        FROM jz_kb_category_access
        WHERE (grantee_type = 'user' AND grantee_id = $1)
           OR (grantee_type = 'department'
               AND grantee_id IN (SELECT department_id FROM jz_department_members WHERE user_id = $1))
           OR (grantee_type = 'workgroup'
               AND grantee_id IN (SELECT workgroup_id FROM jz_workgroup_members WHERE user_id = $1))
        UNION ALL
        SELECT c.id
        FROM jz_kb_categories c
        JOIN accessible a ON c.parent_id = a.category_id
      )
      SELECT category_id FROM accessible
      `,
      [userId],
    );

    return result.rows.map((r: any) => String(r.category_id));
  }
}
