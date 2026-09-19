import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import {
  createInvocationPrincipal,
  InvocationPrincipal,
  principalIsExpired,
} from '../runtime/invocation-principal';
import { McpHttpClient } from '../../../capability/mcp/mcp-http-client';
import { AppRegistryService } from './app-registry.service';

export interface AppServicePrincipalRecord {
  id: string;
  appId: string;
  name: string;
  scopes: string[];
  createdBy: string;
  expiresAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
}

export interface AppDelegationRecord {
  id: string;
  servicePrincipalId: string;
  delegatedByUserId: string;
  scopes: string[];
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
}

@Injectable()
export class AppServicePrincipalService {
  constructor(
    private readonly db: DbService,
    private readonly registry: AppRegistryService,
  ) {}

  async list(appId: string): Promise<AppServicePrincipalRecord[]> {
    const { rows } = await this.db.query(
      `SELECT id, app_id AS "appId", name, scopes, created_by AS "createdBy",
              expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM jz_app_service_principals
       WHERE app_id=$1
       ORDER BY created_at`,
      [appId],
    );
    return rows;
  }

  async create(
    appId: string,
    input: { name: string; scopes: string[]; expiresAt?: string },
    actor: InvocationPrincipal,
  ): Promise<AppServicePrincipalRecord> {
    if (!(await this.registry.findOne(appId))) {
      throw new NotFoundException(`App ${appId} not found`);
    }
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Service principal name is required');
    const scopes = this.normalizeScopes(input.scopes);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      throw new BadRequestException('Service principal expiry must be in the future');
    }
    const { rows } = await this.db.query(
      `INSERT INTO jz_app_service_principals
         (app_id, name, scopes, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, app_id AS "appId", name, scopes, created_by AS "createdBy",
                 expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt"`,
      [appId, name, scopes, actor.principalId, expiresAt ?? null],
    );
    return rows[0];
  }

  async revoke(appId: string, principalId: string): Promise<void> {
    const { rows } = await this.db.query(
      `UPDATE jz_app_service_principals
       SET revoked_at=COALESCE(revoked_at, NOW())
       WHERE id=$1 AND app_id=$2
       RETURNING id`,
      [principalId, appId],
    );
    if (!rows[0]) throw new NotFoundException(`Service principal ${principalId} not found`);
    McpHttpClient.clearAllSessions();
  }

  async createDelegation(
    appId: string,
    servicePrincipalId: string,
    input: { userId: string; scopes: string[]; expiresAt: string },
  ): Promise<AppDelegationRecord> {
    const service = await this.getActiveServiceRecord(appId, servicePrincipalId);
    const scopes = this.normalizeScopes(input.scopes);
    if (!scopes.every(scope => service.scopes.includes('*') || service.scopes.includes(scope))) {
      throw new BadRequestException('Delegation scopes must be a subset of service principal scopes');
    }
    const expiresAt = new Date(input.expiresAt);
    const serviceExpiry = service.expiresAt ? new Date(service.expiresAt).getTime() : undefined;
    if (
      !input.userId
      || !Number.isFinite(expiresAt.getTime())
      || expiresAt.getTime() <= Date.now()
      || (serviceExpiry !== undefined && expiresAt.getTime() > serviceExpiry)
    ) {
      throw new BadRequestException('Delegation user and valid bounded expiry are required');
    }
    const { rows } = await this.db.query(
      `INSERT INTO jz_app_delegations
         (service_principal_id, delegated_by_user_id, scopes, expires_at)
       VALUES ($1,$2,$3,$4)
       RETURNING id, service_principal_id AS "servicePrincipalId",
                 delegated_by_user_id AS "delegatedByUserId", scopes,
                 expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt"`,
      [servicePrincipalId, input.userId, scopes, expiresAt],
    );
    return rows[0];
  }

  async revokeDelegation(appId: string, delegationId: string): Promise<void> {
    const { rows } = await this.db.query(
      `UPDATE jz_app_delegations d
       SET revoked_at=COALESCE(d.revoked_at, NOW())
       FROM jz_app_service_principals sp
       WHERE d.id=$1 AND d.service_principal_id=sp.id AND sp.app_id=$2
       RETURNING d.id`,
      [delegationId, appId],
    );
    if (!rows[0]) throw new NotFoundException(`Delegation ${delegationId} not found`);
    McpHttpClient.clearPrincipalSessions(`delegation:${delegationId}`);
  }

  async resolveService(
    appId: string,
    servicePrincipalId: string,
    origin: string,
  ): Promise<InvocationPrincipal> {
    const record = await this.getActiveServiceRecord(appId, servicePrincipalId);
    return createInvocationPrincipal({
      type: 'service',
      principalId: `service:${record.id}`,
      servicePrincipalId: record.id,
      scopes: record.scopes,
      origin,
      issuedAt: Date.now(),
      expiresAt: record.expiresAt ? new Date(record.expiresAt).getTime() : undefined,
    });
  }

  async resolveDelegation(
    appId: string,
    delegationId: string,
    origin: string,
  ): Promise<InvocationPrincipal> {
    const { rows } = await this.db.query(
      `SELECT d.id, d.service_principal_id AS "servicePrincipalId",
              d.delegated_by_user_id AS "delegatedByUserId", d.scopes,
              d.expires_at AS "expiresAt", d.revoked_at AS "revokedAt",
              sp.app_id AS "appId", sp.scopes AS "serviceScopes",
              sp.expires_at AS "serviceExpiresAt", sp.revoked_at AS "serviceRevokedAt",
              u.role_id AS "roleId", u.status AS "userStatus",
              COALESCE(r.permissions, '{}') AS permissions,
              COALESCE((
                SELECT array_agg(dm.department_id)
                FROM jz_department_members dm
                WHERE dm.user_id=d.delegated_by_user_id
              ), '{}') AS "departmentIds"
       FROM jz_app_delegations d
       JOIN jz_app_service_principals sp ON sp.id=d.service_principal_id
       JOIN jz_users u ON u.id=d.delegated_by_user_id
       LEFT JOIN jz_roles r ON r.id=u.role_id
       WHERE d.id=$1 AND sp.app_id=$2`,
      [delegationId, appId],
    );
    const record = rows[0];
    if (!record) throw new NotFoundException(`Delegation ${delegationId} not found`);
    const expiresAt = new Date(record.expiresAt).getTime();
    const serviceExpiresAt = record.serviceExpiresAt
      ? new Date(record.serviceExpiresAt).getTime()
      : undefined;
    if (
      record.revokedAt
      || record.serviceRevokedAt
      || record.userStatus !== 'active'
      || expiresAt <= Date.now()
      || (serviceExpiresAt !== undefined && serviceExpiresAt <= Date.now())
    ) {
      throw new ForbiddenException(`Delegation ${delegationId} is expired, revoked, or inactive`);
    }
    const serviceScopes = new Set<string>(record.serviceScopes ?? []);
    const scopes = (record.scopes ?? []).filter(
      (scope: string) => serviceScopes.has('*') || serviceScopes.has(scope),
    );
    return createInvocationPrincipal({
      type: 'delegated',
      principalId: `delegation:${record.id}`,
      userId: record.delegatedByUserId,
      delegatedBy: `user:${record.delegatedByUserId}`,
      servicePrincipalId: record.servicePrincipalId,
      roleIds: record.roleId ? [record.roleId] : [],
      departmentIds: record.departmentIds ?? [],
      permissions: record.permissions ?? [],
      scopes,
      origin,
      issuedAt: Date.now(),
      expiresAt: serviceExpiresAt === undefined ? expiresAt : Math.min(expiresAt, serviceExpiresAt),
    });
  }

  async assertActiveForApp(
    appId: string,
    principal: InvocationPrincipal,
  ): Promise<InvocationPrincipal> {
    if (principalIsExpired(principal)) {
      throw new ForbiddenException('Invocation principal is expired');
    }
    if (principal.type === 'service') {
      const id = principal.servicePrincipalId ?? principal.principalId.replace(/^service:/, '');
      const resolved = await this.resolveService(appId, id, principal.origin);
      if (resolved.principalId !== principal.principalId) {
        throw new ForbiddenException('Service principal identity mismatch');
      }
      return resolved;
    }
    if (principal.type === 'delegated') {
      const id = principal.principalId.replace(/^delegation:/, '');
      const resolved = await this.resolveDelegation(appId, id, principal.origin);
      if (
        resolved.principalId !== principal.principalId
        || resolved.servicePrincipalId !== principal.servicePrincipalId
        || resolved.userId !== principal.userId
      ) {
        throw new ForbiddenException('Delegation identity mismatch');
      }
      return resolved;
    }
    throw new ForbiddenException('Service or delegated principal required');
  }

  async assertOwnedByApp(appId: string, servicePrincipalId: string): Promise<void> {
    await this.getActiveServiceRecord(appId, servicePrincipalId);
  }

  private async getActiveServiceRecord(
    appId: string,
    servicePrincipalId: string,
  ): Promise<AppServicePrincipalRecord> {
    const { rows } = await this.db.query(
      `SELECT id, app_id AS "appId", name, scopes, created_by AS "createdBy",
              expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM jz_app_service_principals
       WHERE id=$1 AND app_id=$2`,
      [servicePrincipalId, appId],
    );
    const record = rows[0];
    if (!record) throw new NotFoundException(`Service principal ${servicePrincipalId} not found for app ${appId}`);
    if (record.revokedAt || (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now())) {
      throw new ForbiddenException(`Service principal ${servicePrincipalId} is expired or revoked`);
    }
    return record;
  }

  private normalizeScopes(scopes: readonly string[] | undefined): string[] {
    const normalized = Array.from(new Set((scopes ?? []).map(scope => scope.trim()).filter(Boolean)));
    if (normalized.length === 0) throw new BadRequestException('At least one scope is required');
    return normalized;
  }
}
