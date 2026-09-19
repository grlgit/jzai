import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash, randomUUID } from 'crypto';
import Ajv from 'ajv';
import { DbService } from '../../../db/db.service';
import { TOOL_BRIDGE } from '../../../agent/tool-bridge/tool-provider.interface';
import type { AppConnectionClient } from '../../../agent/tool-bridge/tool-provider.interface';
import { McpRegistryService, McpToolDef } from '../../../capability/mcp/mcp-registry.service';
import { McpHttpClient } from '../../../capability/mcp/mcp-http-client';
import { AppRegistryService } from './app-registry.service';
import { AppGrantService } from './app-grant.service';
import { AppServicePrincipalService } from './app-service-principal.service';
import {
  createInvocationPrincipal,
  createSystemPrincipal,
  InvocationPrincipal,
  principalHasScope,
  principalIsExpired,
} from '../runtime/invocation-principal';

export interface AppConnectionBinding {
  id: string;
  appId: string;
  connectionName: string;
  toolName: string;
  inputSchemaDigest: string;
  config: Record<string, unknown>;
  servicePrincipalId?: string;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppConnectionDescriptor extends AppConnectionBinding {
  inputSchema: unknown;
  outputSchema?: unknown;
  schemaCurrent: boolean;
}

export interface CreateAppConnectionBinding {
  connectionName: string;
  toolName: string;
  config?: Record<string, unknown>;
  servicePrincipalId?: string;
}

@Injectable()
export class AppConnectionBindingService {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(
    private readonly db: DbService,
    private readonly registry: AppRegistryService,
    private readonly grants: AppGrantService,
    private readonly servicePrincipals: AppServicePrincipalService,
    private readonly mcpRegistry: McpRegistryService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async listBindings(appId: string): Promise<AppConnectionBinding[]> {
    const { rows } = await this.db.query(
      `SELECT id, app_id AS "appId", connection_name AS "connectionName",
              tool_name AS "toolName", input_schema_digest AS "inputSchemaDigest",
              config, service_principal_id AS "servicePrincipalId", enabled,
              created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM jz_app_connection_bindings
       WHERE app_id=$1
       ORDER BY created_at`,
      [appId],
    );
    return rows;
  }

  createClient(appId: string, principal: InvocationPrincipal | undefined): AppConnectionClient {
    return Object.freeze({
      listBindings: async () => {
        await this.assertAppAccess(appId, principal);
        return this.listBindingDescriptors(appId);
      },
      describe: async (bindingId: string) => {
        await this.assertAppAccess(appId, principal);
        return this.describeBinding(appId, bindingId);
      },
      invoke: (bindingId: string, params: unknown) =>
        this.invoke(appId, bindingId, params, principal),
    });
  }

  createServiceClient(appId: string, origin = `app-runtime:${appId}`): AppConnectionClient {
    return Object.freeze({
      listBindings: () => this.listBindingDescriptors(appId),
      describe: (bindingId: string) => this.describeBinding(appId, bindingId),
      invoke: async (bindingId: string, params: unknown) => {
        const binding = await this.getBinding(appId, bindingId);
        if (!binding.servicePrincipalId) {
          const principal = createSystemPrincipal(origin);
          await this.auditBinding(binding, principal, 'denied', 'SERVICE_PRINCIPAL_REQUIRED');
          throw new ForbiddenException(
            `Connection binding ${bindingId} requires an assigned service principal for background use`,
          );
        }
        const principal = await this.servicePrincipals.resolveService(
          appId,
          binding.servicePrincipalId,
          origin,
        );
        return this.invoke(appId, bindingId, params, principal);
      },
    });
  }

  async createBinding(
    appId: string,
    input: CreateAppConnectionBinding,
    actor: InvocationPrincipal,
  ): Promise<AppConnectionBinding> {
    const app = await this.registry.findOne(appId);
    if (!app) throw new NotFoundException(`App ${appId} not found`);
    const canUseConnections = app.manifest?.platformCapabilities?.includes('connections')
      || app.manifest?.usesPlatformTools?.includes('mcp');
    if (!canUseConnections) {
      throw new ForbiddenException(`App ${appId} does not declare connection access`);
    }
    if (input.servicePrincipalId) {
      await this.servicePrincipals.assertOwnedByApp(appId, input.servicePrincipalId);
    }
    if (!this.mcpRegistry.isAllowedForUser(input.connectionName, actor.userId, actor.roleIds)) {
      throw new ForbiddenException(`No access to connection ${input.connectionName}`);
    }
    const tool = this.getConnectionTool(input.connectionName, input.toolName);
    const config = input.config ?? {};
    this.assertNonSensitiveConfig(config);
    const digest = this.schemaDigest(tool.inputSchema);
    const { rows } = await this.db.query(
      `INSERT INTO jz_app_connection_bindings
         (app_id, connection_name, tool_name, input_schema_digest, config,
          service_principal_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, app_id AS "appId", connection_name AS "connectionName",
                 tool_name AS "toolName", input_schema_digest AS "inputSchemaDigest",
                 config, service_principal_id AS "servicePrincipalId", enabled,
                 created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        appId,
        input.connectionName,
        input.toolName,
        digest,
        JSON.stringify(config),
        input.servicePrincipalId ?? null,
        actor.principalId,
      ],
    );
    return rows[0];
  }

  async listBindingDescriptors(appId: string): Promise<AppConnectionDescriptor[]> {
    const bindings = await this.listBindings(appId);
    return bindings.map(binding => this.toDescriptor(binding));
  }

  async describeBinding(appId: string, bindingId: string): Promise<AppConnectionDescriptor> {
    const binding = await this.getBinding(appId, bindingId);
    return this.toDescriptor(binding);
  }

  async deleteBinding(appId: string, bindingId: string): Promise<void> {
    const result = await this.db.query(
      'DELETE FROM jz_app_connection_bindings WHERE id=$1 AND app_id=$2 RETURNING connection_name AS "connectionName"',
      [bindingId, appId],
    );
    if (result.rows.length === 0) throw new NotFoundException(`Connection binding ${bindingId} not found`);
    McpHttpClient.clearConnectionSessions(result.rows[0].connectionName);
  }

  async setEnabled(appId: string, bindingId: string, enabled: boolean): Promise<AppConnectionBinding> {
    const { rows } = await this.db.query(
      `UPDATE jz_app_connection_bindings
       SET enabled=$3, updated_at=NOW()
       WHERE id=$1 AND app_id=$2
       RETURNING id, app_id AS "appId", connection_name AS "connectionName",
                 tool_name AS "toolName", input_schema_digest AS "inputSchemaDigest",
                 config, service_principal_id AS "servicePrincipalId", enabled,
                 created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [bindingId, appId, enabled],
    );
    if (!rows[0]) throw new NotFoundException(`Connection binding ${bindingId} not found`);
    McpHttpClient.clearConnectionSessions(rows[0].connectionName);
    return rows[0];
  }

  async listGrants(appId: string, bindingId: string): Promise<unknown[]> {
    await this.getBinding(appId, bindingId);
    const { rows } = await this.db.query(
      `SELECT id, target_type AS "targetType", target_id AS "targetId", effect,
              created_at AS "createdAt"
       FROM jz_app_connection_binding_grants
       WHERE binding_id=$1
       ORDER BY created_at`,
      [bindingId],
    );
    return rows;
  }

  async setGrant(
    appId: string,
    bindingId: string,
    input: { targetType: 'user' | 'role' | 'department'; targetId: string; effect: 'allow' | 'deny' },
  ): Promise<unknown> {
    const binding = await this.getBinding(appId, bindingId);
    if (!['user', 'role', 'department'].includes(input.targetType)) {
      throw new BadRequestException('Invalid binding grant target type');
    }
    if (!['allow', 'deny'].includes(input.effect) || !input.targetId) {
      throw new BadRequestException('Invalid binding grant');
    }
    const { rows } = await this.db.query(
      `INSERT INTO jz_app_connection_binding_grants
         (binding_id, target_type, target_id, effect)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (binding_id, target_type, target_id)
       DO UPDATE SET effect=EXCLUDED.effect
       RETURNING id, target_type AS "targetType", target_id AS "targetId", effect,
                 created_at AS "createdAt"`,
      [bindingId, input.targetType, input.targetId, input.effect],
    );
    McpHttpClient.clearConnectionSessions(binding.connectionName);
    return rows[0];
  }

  async deleteGrant(
    appId: string,
    bindingId: string,
    targetType: string,
    targetId: string,
  ): Promise<void> {
    const binding = await this.getBinding(appId, bindingId);
    await this.db.query(
      `DELETE FROM jz_app_connection_binding_grants
       WHERE binding_id=$1 AND target_type=$2 AND target_id=$3`,
      [bindingId, targetType, targetId],
    );
    McpHttpClient.clearConnectionSessions(binding.connectionName);
  }

  async invoke(
    appId: string,
    bindingId: string,
    params: unknown,
    principal: InvocationPrincipal | undefined,
  ): Promise<unknown> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const binding = await this.getBinding(appId, bindingId);
    const audit = (
      auditPrincipal: InvocationPrincipal,
      outcome: 'success' | 'denied' | 'error',
      errorCode?: string,
    ) => this.auditBinding(binding, auditPrincipal, outcome, errorCode, requestId, startedAt);

    if (!principal || principalIsExpired(principal)) {
      await audit(
        principal ?? {
          type: 'system',
          principalId: 'anonymous',
          roleIds: [],
          departmentIds: [],
          permissions: [],
          scopes: [],
          origin: 'unknown',
          issuedAt: 0,
        },
        'denied',
        'INVALID_PRINCIPAL',
      );
      throw new ForbiddenException('A valid invocation principal is required');
    }

    let effectivePrincipal = principal;
    if (!binding.enabled) {
      await audit(effectivePrincipal, 'denied', 'BINDING_DISABLED');
      throw new ForbiddenException(`Connection binding ${bindingId} is disabled`);
    }
    if (effectivePrincipal.type === 'service' || effectivePrincipal.type === 'delegated') {
      try {
        effectivePrincipal = await this.servicePrincipals.assertActiveForApp(appId, effectivePrincipal);
      } catch (error) {
        await audit(effectivePrincipal, 'denied', 'INVALID_SERVICE_PRINCIPAL');
        throw error;
      }
      if (
        !binding.servicePrincipalId
        || effectivePrincipal.servicePrincipalId !== binding.servicePrincipalId
      ) {
        await audit(effectivePrincipal, 'denied', 'SERVICE_PRINCIPAL_MISMATCH');
        throw new ForbiddenException(`Connection binding ${bindingId} is not assigned to this service principal`);
      }
    }
    if (binding.servicePrincipalId && effectivePrincipal.type === 'system') {
      await audit(effectivePrincipal, 'denied', 'SERVICE_PRINCIPAL_REQUIRED');
      throw new ForbiddenException(`Connection binding ${bindingId} requires its assigned service principal`);
    }
    if (!(await this.isAllowed(binding, effectivePrincipal))) {
      await audit(effectivePrincipal, 'denied', 'FORBIDDEN');
      throw new ForbiddenException(`No grant for connection binding ${bindingId}`);
    }

    const tool = this.getConnectionTool(binding.connectionName, binding.toolName);
    const currentDigest = this.schemaDigest(tool.inputSchema);
    if (currentDigest !== binding.inputSchemaDigest) {
      await audit(effectivePrincipal, 'error', 'SCHEMA_DRIFT');
      throw new BadRequestException(`Connection binding ${bindingId} schema changed; recreate the binding`);
    }

    const validate = this.ajv.compile(tool.inputSchema ?? { type: 'object' });
    if (!validate(params)) {
      const message = this.ajv.errorsText(validate.errors, { separator: '; ' });
      await audit(effectivePrincipal, 'error', 'INVALID_ARGUMENTS');
      throw new BadRequestException(`Invalid connection arguments: ${message}`);
    }

    const toolId = `mcp_${binding.connectionName}_${binding.toolName}`;
    const connectorPrincipal = effectivePrincipal.type === 'service'
      ? createInvocationPrincipal({
          ...effectivePrincipal,
          scopes: [
            ...effectivePrincipal.scopes,
            `mcp:${binding.connectionName}:${binding.toolName}:invoke`,
          ],
        })
      : effectivePrincipal;
    let result: unknown;
    try {
      const bridge = this.moduleRef.get<{
        callTool(name: string, input: unknown, caller?: InvocationPrincipal): Promise<unknown>;
      }>(TOOL_BRIDGE, { strict: false });
      result = await bridge.callTool(toolId, params, connectorPrincipal);
    } catch (error) {
      await audit(effectivePrincipal, 'error', 'TOOL_ERROR');
      throw error;
    }
    await audit(effectivePrincipal, 'success');
    return result;
  }

  private async getBinding(appId: string, bindingId: string): Promise<AppConnectionBinding> {
    const { rows } = await this.db.query(
      `SELECT id, app_id AS "appId", connection_name AS "connectionName",
              tool_name AS "toolName", input_schema_digest AS "inputSchemaDigest",
              config, service_principal_id AS "servicePrincipalId", enabled,
              created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM jz_app_connection_bindings
       WHERE id=$1 AND app_id=$2`,
      [bindingId, appId],
    );
    if (!rows[0]) throw new NotFoundException(`Connection binding ${bindingId} not found`);
    return rows[0];
  }

  private toDescriptor(binding: AppConnectionBinding): AppConnectionDescriptor {
    const tool = this.getConnectionTool(binding.connectionName, binding.toolName);
    return {
      ...binding,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      schemaCurrent: binding.inputSchemaDigest === this.schemaDigest(tool.inputSchema),
    };
  }

  private getConnectionTool(connectionName: string, toolName: string): McpToolDef {
    const connection = this.mcpRegistry.get(connectionName);
    if (!connection || !connection.enabled) {
      throw new NotFoundException(`Connection ${connectionName} not found or disabled`);
    }
    const matches = connection.tools.filter(tool => tool.name === toolName);
    if (matches.length !== 1) {
      throw new NotFoundException(
        `Connection tool ${connectionName}/${toolName} must resolve exactly once; received ${matches.length}`,
      );
    }
    return matches[0];
  }

  private async assertAppAccess(
    appId: string,
    principal: InvocationPrincipal | undefined,
  ): Promise<void> {
    if (!principal || principalIsExpired(principal)) {
      throw new ForbiddenException('A valid invocation principal is required');
    }
    if (principal.permissions.includes('sys:admin')) return;
    if (principal.type === 'service' || principal.type === 'system') {
      if (
        principalHasScope(principal, 'app:invoke')
        || principalHasScope(principal, `app:${appId}:invoke`)
      ) return;
      throw new ForbiddenException(`No grant for app ${appId}`);
    }
    if (!principal.userId || !(await this.grants.hasAppAccessForPrincipal(appId, principal))) {
      throw new ForbiddenException(`No grant for app ${appId}`);
    }
  }

  private async isAllowed(binding: AppConnectionBinding, principal: InvocationPrincipal): Promise<boolean> {
    if (principal.type === 'user' && principal.permissions.includes('sys:admin')) return true;
    const hasConnectionScope = principalHasScope(principal, 'connection:invoke')
      || principalHasScope(principal, `connection:${binding.id}:invoke`);
    if (principal.type === 'service' || principal.type === 'system') {
      return hasConnectionScope;
    }
    if (principal.type === 'delegated' && !hasConnectionScope) return false;
    if (!principal.userId) return false;
    if (!this.mcpRegistry.isAllowedForUser(binding.connectionName, principal.userId, principal.roleIds)) {
      return false;
    }

    const { rows } = await this.db.query(
      `SELECT effect
       FROM jz_app_connection_binding_grants g
       WHERE g.binding_id=$1
         AND (
           (g.target_type='user' AND g.target_id=$2)
           OR (g.target_type='role' AND g.target_id = ANY($3::text[]))
           OR (g.target_type='department' AND (
             g.target_id = ANY($4::text[])
             OR g.target_id IN (
               SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id=$2
             )
           ))
         )`,
      [binding.id, principal.userId, [...principal.roleIds], [...principal.departmentIds]],
    );
    if (rows.some(row => row.effect === 'deny')) return false;
    if (rows.some(row => row.effect === 'allow')) return true;
    return this.grants.hasAppAccessForPrincipal(binding.appId, principal);
  }

  private schemaDigest(schema: unknown): string {
    return createHash('sha256').update(this.stableJson(schema ?? {})).digest('hex');
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => this.stableJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableJson(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private assertNonSensitiveConfig(value: unknown, path: string[] = []): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.assertNonSensitiveConfig(item, [...path, String(index)]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|password|passwd|token|api[_-]?key|credential)/i.test(key)) {
        throw new BadRequestException(`Binding config must not contain secrets: ${[...path, key].join('.')}`);
      }
      this.assertNonSensitiveConfig(item, [...path, key]);
    }
  }

  private async auditBinding(
    binding: AppConnectionBinding,
    principal: InvocationPrincipal,
    outcome: 'success' | 'denied' | 'error',
    errorCode?: string,
    requestId = randomUUID(),
    startedAt = Date.now(),
  ): Promise<void> {
    await this.audit(
      binding.appId,
      binding.id,
      principal.principalId,
      principal.userId,
      binding.connectionName,
      binding.toolName,
      requestId,
      Math.max(0, Date.now() - startedAt),
      outcome,
      errorCode,
    );
  }

  private async audit(
    appId: string,
    bindingId: string,
    principalId: string,
    userId: string | undefined,
    connectionName: string,
    toolName: string,
    requestId: string,
    durationMs: number,
    outcome: 'success' | 'denied' | 'error',
    errorCode?: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO jz_app_connection_invocation_audit
         (app_id, binding_id, principal_id, user_id, connection_name, tool_name,
          request_id, duration_ms, outcome, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        appId,
        bindingId,
        principalId,
        userId ?? null,
        connectionName,
        toolName,
        requestId,
        durationMs,
        outcome,
        errorCode ?? null,
      ],
    );
  }
}
