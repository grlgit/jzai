import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { AppManifest } from '../validators/manifest.schema';

export interface AppDatabaseResourceState {
  roleExists: boolean;
  schemaExists: boolean;
  schemaOwner: string | null;
}

/**
 * Manages per-app PostgreSQL SCHEMA isolation.
 * Creates dedicated ROLE + SCHEMA per app, revokes public access,
 * grants only declared shared tables as read-only.
 * All operations execute in a single transaction — failure rolls back entirely.
 */
@Injectable()
export class AppSchemaService {
  private readonly logger = new Logger(AppSchemaService.name);

  constructor(private readonly db: DbService) {}

  /** Verify the platform DB user has CREATEROLE privilege */
  async checkCreaterolePrivilege(): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user`,
    );
    return rows[0]?.rolcreaterole === true;
  }

  /** Create SCHEMA + ROLE for the app; grant only declared shared tables */
  async createSchemaAndRole(manifest: AppManifest, rolePassword: string): Promise<void> {
    const db = manifest.database;
    if (!db) return;

    const schemaName = db.schemaName;
    const roleName = `${schemaName}_role`;
    const sharedTables = db.sharedTablesRead ?? [];
    const statementTimeout = `${db.statementTimeoutMs ?? 30000}ms`;

    await this.db.transaction(async client => {
      const { rows } = await client.query<{ statement: string }>(
        `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', $1::text, $2::text) AS statement`,
        [roleName, rolePassword],
      );
      await client.query(rows[0].statement);

      // 2. Create schema owned by that role
      await client.query(
        `CREATE SCHEMA "${schemaName}" AUTHORIZATION "${roleName}"`,
      );

      // 3. Revoke public schema access
      await client.query(`REVOKE ALL ON SCHEMA public FROM "${roleName}"`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${roleName}"`);

      // 4. Grant read access to declared shared tables
      if (sharedTables.length > 0) {
        await client.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
        for (const table of sharedTables) {
          await client.query(`GRANT SELECT ON public."${table}" TO "${roleName}"`);
        }
      }

      // 5. Set role-level settings (search_path + timeouts)
      await client.query(`ALTER ROLE "${roleName}" SET search_path = "${schemaName}"`);
      await client.query(`ALTER ROLE "${roleName}" SET statement_timeout = '${statementTimeout}'`);
      await client.query(`ALTER ROLE "${roleName}" SET idle_in_transaction_session_timeout = '60s'`);
    });

    this.logger.log(`Created schema "${schemaName}" and role "${roleName}" for app ${manifest.appId}`);
  }

  async getResourceState(manifest: AppManifest): Promise<AppDatabaseResourceState> {
    const db = manifest.database;
    if (!db) return { roleExists: false, schemaExists: false, schemaOwner: null };

    const roleName = `${db.schemaName}_role`;
    const result = await this.db.query(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS "roleExists",
              EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $2) AS "schemaExists",
              (SELECT role.rolname
               FROM pg_namespace schema
               JOIN pg_roles role ON role.oid = schema.nspowner
               WHERE schema.nspname = $2) AS "schemaOwner"`,
      [roleName, db.schemaName],
    );
    const rows = result.rows as AppDatabaseResourceState[];
    return rows[0] ?? { roleExists: false, schemaExists: false, schemaOwner: null };
  }

  async restoreSchemaAndRole(manifest: AppManifest, rolePassword: string): Promise<void> {
    const db = manifest.database;
    if (!db) return;

    const roleName = `${db.schemaName}_role`;
    const resources = await this.getResourceState(manifest);
    if (!resources.roleExists || !resources.schemaExists || resources.schemaOwner !== roleName) {
      throw new BadRequestException('应用保留的数据库资源不完整或所有权不匹配，无法安全恢复。');
    }
    await this.assertSafeRole(roleName);

    const sharedTables = db.sharedTablesRead ?? [];
    const statementTimeout = `${db.statementTimeoutMs ?? 30000}ms`;
    await this.db.transaction(async client => {
      const { rows } = await client.query<{ statement: string }>(
        `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOINHERIT', $1::text, $2::text) AS statement`,
        [roleName, rolePassword],
      );
      await client.query(rows[0].statement);
      await client.query(`REVOKE ALL ON SCHEMA public FROM "${roleName}"`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${roleName}"`);

      if (sharedTables.length > 0) {
        await client.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
        for (const table of sharedTables) {
          await client.query(`GRANT SELECT ON public."${table}" TO "${roleName}"`);
        }
      }

      await client.query(`ALTER ROLE "${roleName}" SET search_path = "${db.schemaName}"`);
      await client.query(`ALTER ROLE "${roleName}" SET statement_timeout = '${statementTimeout}'`);
      await client.query(`ALTER ROLE "${roleName}" SET idle_in_transaction_session_timeout = '60s'`);
    });
  }

  async purgeOrphanedResources(manifest: AppManifest): Promise<void> {
    const db = manifest.database;
    if (!db) return;

    const roleName = `${db.schemaName}_role`;
    const resources = await this.getResourceState(manifest);
    if (!resources.roleExists && !resources.schemaExists) return;
    if (resources.schemaExists && resources.schemaOwner !== roleName) {
      throw new BadRequestException('遗留数据库 schema 的所有者不匹配，无法安全清理。');
    }
    if (resources.roleExists) await this.assertSafeRole(roleName);

    await this.dropSchemaAndRole(manifest);
  }

  private async assertSafeRole(roleName: string): Promise<void> {
    const result = await this.db.query(
      `SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls AS unsafe
       FROM pg_roles WHERE rolname = $1`,
      [roleName],
    );
    const rows = result.rows as Array<{ unsafe: boolean }>;
    if (rows[0]?.unsafe) {
      throw new BadRequestException('应用数据库角色权限异常，无法安全复用或清理。');
    }
  }

  /** Drop SCHEMA and ROLE for the app on uninstall */
  async dropSchemaAndRole(manifest: AppManifest): Promise<void> {
    const db = manifest.database;
    if (!db) return;

    const schemaName = db.schemaName;
    const roleName = `${schemaName}_role`;

    // DROP order matters — role cannot be dropped while it owns objects
    await this.db.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await this.db.query(`REASSIGN OWNED BY "${roleName}" TO CURRENT_USER`).catch(() => {});
    await this.db.query(`DROP OWNED BY "${roleName}"`).catch(() => {});
    await this.db.query(`DROP ROLE IF EXISTS "${roleName}"`);

    this.logger.log(`Dropped schema "${schemaName}" and role "${roleName}" for app ${manifest.appId}`);
  }

  /** Get the role name for a given manifest */
  getRoleName(manifest: AppManifest): string | null {
    return manifest.database ? `${manifest.database.schemaName}_role` : null;
  }
}
