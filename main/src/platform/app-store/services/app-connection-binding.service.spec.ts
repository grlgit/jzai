import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TOOL_BRIDGE } from '../../../agent/tool-bridge/tool-provider.interface';
import { McpRegistryService } from '../../../capability/mcp/mcp-registry.service';
import { DbService } from '../../../db/db.service';
import { AppConnectionBindingService } from './app-connection-binding.service';
import { AppGrantService } from './app-grant.service';
import { AppRegistryService } from './app-registry.service';
import { AppServicePrincipalService } from './app-service-principal.service';
import { createInvocationPrincipal, createUserPrincipal } from '../runtime/invocation-principal';

const inputSchema = {
  type: 'object',
  properties: { orderId: { type: 'string' } },
  required: ['orderId'],
  additionalProperties: false,
};
const outputSchema = {
  type: 'object',
  properties: { status: { type: 'string' } },
};

function createFixture() {
  const bridge = { callTool: jest.fn().mockResolvedValue({ ok: true }) };
  const db = { query: jest.fn() };
  const registry = {
    findOne: jest.fn().mockResolvedValue({
      appId: 'com.example.app',
      manifest: { platformCapabilities: ['connections'] },
    }),
  };
  const grants = { hasAppAccessForPrincipal: jest.fn().mockResolvedValue(true) };
  const servicePrincipals = {
    assertOwnedByApp: jest.fn().mockResolvedValue(undefined),
    assertActiveForApp: jest.fn().mockImplementation(async (
      _appId: string,
      invocationPrincipal: ReturnType<typeof createInvocationPrincipal>,
    ) => invocationPrincipal),
    resolveService: jest.fn().mockImplementation(async (_appId: string, servicePrincipalId: string, origin: string) =>
      createInvocationPrincipal({
        type: 'service',
        principalId: `service:${servicePrincipalId}`,
        servicePrincipalId,
        scopes: ['connection:invoke'],
        origin,
        issuedAt: Date.now(),
      })),
  };
  const mcpRegistry = {
    get: jest.fn().mockReturnValue({
      name: 'erp_primary',
      enabled: true,
      tools: [{ name: 'orders', description: 'Orders', inputSchema, outputSchema }],
    }),
    isAllowedForUser: jest.fn().mockReturnValue(true),
  };
  const moduleRef = { get: jest.fn().mockReturnValue(bridge) };
  const service = new AppConnectionBindingService(
    db as any,
    registry as any,
    grants as any,
    servicePrincipals as any,
    mcpRegistry as any,
    moduleRef as any,
  );
  const binding = {
    id: '9aaeece3-3160-49a5-953f-cdf346bd156f',
    appId: 'com.example.app',
    connectionName: 'erp_primary',
    toolName: 'orders',
    inputSchemaDigest: (service as any).schemaDigest(inputSchema),
    config: {},
    servicePrincipalId: undefined as string | undefined,
    enabled: true,
    createdBy: 'user:admin',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM jz_app_connection_bindings') && sql.includes('WHERE id=$1')) {
      return { rows: [binding] };
    }
    if (sql.includes('FROM jz_app_connection_bindings') && sql.includes('WHERE app_id=$1')) {
      return { rows: [binding] };
    }
    if (sql.includes('FROM jz_app_connection_binding_grants')) return { rows: [] };
    return { rows: [] };
  });
  return {
    service,
    db,
    registry,
    grants,
    servicePrincipals,
    mcpRegistry,
    moduleRef,
    bridge,
    binding,
  };
}

describe('AppConnectionBindingService', () => {
  const principal = createUserPrincipal(
    { id: 'user-1', role: { id: 'planner', permissions: [] } },
    'test',
  );

  test('invokes only the exact bound MCP tool with the trusted principal', async () => {
    const { service, bridge, binding } = createFixture();

    await expect(service.invoke(
      binding.appId,
      binding.id,
      { orderId: 'SO-1' },
      principal,
    )).resolves.toEqual({ ok: true });

    expect(bridge.callTool).toHaveBeenCalledWith(
      'mcp_erp_primary_orders',
      { orderId: 'SO-1' },
      principal,
    );
  });

  test('audits identity, request ID, duration, and outcome without persisting payloads', async () => {
    const { service, db, binding } = createFixture();

    await service.invoke(
      binding.appId,
      binding.id,
      { orderId: 'SO-sensitive' },
      principal,
    );

    const auditCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO jz_app_connection_invocation_audit'));
    expect(auditCall).toBeDefined();
    expect(auditCall![1]).toEqual([
      binding.appId,
      binding.id,
      principal.principalId,
      principal.userId,
      binding.connectionName,
      binding.toolName,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.any(Number),
      'success',
      null,
    ]);
    expect(JSON.stringify(auditCall)).not.toContain('SO-sensitive');
  });

  test('rejects arguments that do not match the bound schema', async () => {
    const { service, bridge, binding } = createFixture();

    await expect(service.invoke(binding.appId, binding.id, {}, principal))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  test('rejects invocation when the connector schema digest has drifted', async () => {
    const { service, bridge, binding } = createFixture();
    binding.inputSchemaDigest = 'stale';

    await expect(service.invoke(
      binding.appId,
      binding.id,
      { orderId: 'SO-1' },
      principal,
    )).rejects.toThrow('schema changed');
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  test('rejects missing invocation identity before connector execution', async () => {
    const { service, bridge, binding } = createFixture();

    await expect(service.invoke(binding.appId, binding.id, { orderId: 'SO-1' }, undefined))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  test('does not allow secrets in binding config', async () => {
    const { service } = createFixture();

    await expect(service.createBinding(
      'com.example.app',
      {
        connectionName: 'erp_primary',
        toolName: 'orders',
        config: { apiToken: 'secret-value' },
      },
      principal,
    )).rejects.toThrow('must not contain secrets');
  });

  test('rejects binding creation when the actor cannot access the connector', async () => {
    const { service, db, mcpRegistry } = createFixture();
    mcpRegistry.isAllowedForUser.mockReturnValue(false);

    await expect(service.createBinding(
      'com.example.app',
      {
        connectionName: 'erp_primary',
        toolName: 'orders',
      },
      principal,
    )).rejects.toThrow('No access to connection erp_primary');

    expect(mcpRegistry.isAllowedForUser).toHaveBeenCalledWith(
      'erp_primary',
      'user-1',
      ['planner'],
    );
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO jz_app_connection_bindings'),
      expect.anything(),
    );
  });

  test('rejects a service principal that is not owned by the app', async () => {
    const { service, servicePrincipals } = createFixture();
    servicePrincipals.assertOwnedByApp.mockRejectedValueOnce(
      new ForbiddenException('cross-app service principal'),
    );

    await expect(service.createBinding(
      'com.example.app',
      {
        connectionName: 'erp_primary',
        toolName: 'orders',
        servicePrincipalId: 'foreign-principal',
      },
      principal,
    )).rejects.toThrow('cross-app service principal');
  });

  test('requires an unattended caller to match the assigned service principal', async () => {
    const { service, bridge, binding, servicePrincipals } = createFixture();
    binding.servicePrincipalId = 'service-1';
    const servicePrincipal = createInvocationPrincipal({
      type: 'service',
      principalId: 'service:service-2',
      servicePrincipalId: 'service-2',
      scopes: ['connection:invoke'],
      origin: 'test',
      issuedAt: Date.now(),
    });

    await expect(service.invoke(
      binding.appId,
      binding.id,
      { orderId: 'SO-1' },
      servicePrincipal,
    )).rejects.toThrow('not assigned to this service principal');

    expect(servicePrincipals.assertActiveForApp).toHaveBeenCalledWith(
      binding.appId,
      servicePrincipal,
    );
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  test('accepts an active delegated principal scoped to the assigned binding', async () => {
    const { service, binding, servicePrincipals, bridge, mcpRegistry } = createFixture();
    binding.servicePrincipalId = 'service-1';
    const delegated = createInvocationPrincipal({
      type: 'delegated',
      principalId: 'delegation:delegation-1',
      userId: 'user-1',
      delegatedBy: 'user:user-1',
      servicePrincipalId: 'service-1',
      roleIds: ['planner'],
      scopes: [`connection:${binding.id}:invoke`],
      origin: 'job:test',
      issuedAt: Date.now(),
    });

    await expect(service.invoke(
      binding.appId,
      binding.id,
      { orderId: 'SO-1' },
      delegated,
    )).resolves.toEqual({ ok: true });

    expect(servicePrincipals.assertActiveForApp).toHaveBeenCalledWith(binding.appId, delegated);
    expect(mcpRegistry.isAllowedForUser).toHaveBeenCalledWith('erp_primary', 'user-1', ['planner']);
    expect(bridge.callTool).toHaveBeenCalledWith(
      'mcp_erp_primary_orders',
      { orderId: 'SO-1' },
      delegated,
    );
  });

  test('rejects stale delegated scopes and administrator permissions after canonical revalidation', async () => {
    const { service, binding, servicePrincipals, bridge, mcpRegistry } = createFixture();
    binding.servicePrincipalId = 'service-1';
    const delegated = createInvocationPrincipal({
      type: 'delegated',
      principalId: 'delegation:delegation-1',
      userId: 'user-1',
      servicePrincipalId: 'service-1',
      permissions: ['sys:admin'],
      scopes: ['connection:invoke'],
      origin: 'job:test',
      issuedAt: Date.now(),
    });
    const canonical = createInvocationPrincipal({
      type: 'delegated',
      principalId: 'delegation:delegation-1',
      userId: 'user-1',
      servicePrincipalId: 'service-1',
      permissions: ['sys:admin'],
      scopes: [],
      origin: 'job:test',
      issuedAt: Date.now(),
    });
    servicePrincipals.assertActiveForApp.mockResolvedValueOnce(canonical);

    await expect(service.invoke(
      binding.appId,
      binding.id,
      { orderId: 'SO-1' },
      delegated,
    )).rejects.toThrow('No grant for connection binding');

    expect(mcpRegistry.isAllowedForUser).not.toHaveBeenCalled();
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  test('rejects stale service scopes after canonical revalidation', async () => {
    const { service, binding, servicePrincipals, bridge } = createFixture();
    binding.servicePrincipalId = 'service-1';
    const servicePrincipal = createInvocationPrincipal({
      type: 'service',
      principalId: 'service:service-1',
      servicePrincipalId: 'service-1',
      scopes: ['connection:invoke'],
      origin: 'job:test',
      issuedAt: Date.now(),
    });
    const canonical = createInvocationPrincipal({
      type: 'service',
      principalId: 'service:service-1',
      servicePrincipalId: 'service-1',
      scopes: [],
      origin: 'job:test',
      issuedAt: Date.now(),
    });
    servicePrincipals.assertActiveForApp.mockResolvedValueOnce(canonical);

    await expect(service.invoke(
      binding.appId,
      binding.id,
      { orderId: 'SO-1' },
      servicePrincipal,
    )).rejects.toThrow('No grant for connection binding');
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  test('rejects delegated invocation after revocation revalidation', async () => {
    const { service, binding, servicePrincipals, bridge } = createFixture();
    binding.servicePrincipalId = 'service-1';
    const delegated = createInvocationPrincipal({
      type: 'delegated',
      principalId: 'delegation:delegation-1',
      userId: 'user-1',
      servicePrincipalId: 'service-1',
      scopes: ['connection:invoke'],
      origin: 'job:test',
      issuedAt: Date.now(),
    });
    servicePrincipals.assertActiveForApp.mockRejectedValueOnce(
      new ForbiddenException('Delegation delegation-1 is expired or revoked'),
    );

    await expect(service.invoke(
      binding.appId,
      binding.id,
      { orderId: 'SO-1' },
      delegated,
    )).rejects.toThrow('expired or revoked');
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  test('returns schema-rich descriptors through the principal-bound client', async () => {
    const { service, binding } = createFixture();

    await expect(service.createClient(binding.appId, principal).listBindings())
      .resolves.toEqual([expect.objectContaining({
        id: binding.id,
        inputSchema,
        outputSchema,
        schemaCurrent: true,
      })]);
  });

  test('authorizes binding discovery through the principal-bound client', async () => {
    const { service, grants } = createFixture();
    grants.hasAppAccessForPrincipal.mockResolvedValueOnce(false);

    await expect(service.createClient('com.example.app', principal).listBindings())
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  test('resolves the binding service principal for each background invocation', async () => {
    const { service, binding, servicePrincipals, bridge } = createFixture();
    binding.servicePrincipalId = 'service-1';

    await expect(service.createServiceClient(binding.appId).invoke(
      binding.id,
      { orderId: 'SO-1' },
    )).resolves.toEqual({ ok: true });

    expect(servicePrincipals.resolveService).toHaveBeenCalledWith(
      binding.appId,
      'service-1',
      `app-runtime:${binding.appId}`,
    );
    expect(servicePrincipals.assertActiveForApp).toHaveBeenCalledWith(
      binding.appId,
      expect.objectContaining({
        principalId: 'service:service-1',
        servicePrincipalId: 'service-1',
      }),
    );
    expect(bridge.callTool).toHaveBeenCalledWith(
      'mcp_erp_primary_orders',
      { orderId: 'SO-1' },
      expect.objectContaining({
        principalId: 'service:service-1',
        scopes: expect.arrayContaining([
          'connection:invoke',
          'mcp:erp_primary:orders:invoke',
        ]),
      }),
    );
  });

  test('rejects background invocation when the binding has no service principal', async () => {
    const { service, binding, bridge } = createFixture();

    await expect(service.createServiceClient(binding.appId).invoke(
      binding.id,
      { orderId: 'SO-1' },
    )).rejects.toThrow('requires an assigned service principal');
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  test('propagates service principal revocation before connector execution', async () => {
    const { service, binding, servicePrincipals, bridge } = createFixture();
    binding.servicePrincipalId = 'service-1';
    servicePrincipals.resolveService.mockRejectedValueOnce(
      new ForbiddenException('Service principal service-1 is expired or revoked'),
    );

    await expect(service.createServiceClient(binding.appId).invoke(
      binding.id,
      { orderId: 'SO-1' },
    )).rejects.toThrow('expired or revoked');
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  test('keeps one hundred calls pinned to the exact bound connection', async () => {
    const { service, db, mcpRegistry, bridge, binding } = createFixture();
    const secondary = {
      ...binding,
      id: '0dc9bf03-f4be-4308-9ad7-ea654bc196db',
      connectionName: 'erp_secondary',
    };
    mcpRegistry.get.mockImplementation((name: string) => ({
      name,
      enabled: true,
      tools: [{ name: 'orders', description: 'Orders', inputSchema }],
    }));
    db.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM jz_app_connection_bindings') && sql.includes('WHERE id=$1')) {
        return { rows: [params[0] === secondary.id ? secondary : binding] };
      }
      if (sql.includes('FROM jz_app_connection_binding_grants')) return { rows: [] };
      return { rows: [] };
    });
    bridge.callTool.mockImplementation(async (name: string) => ({
      marker: name === 'mcp_erp_primary_orders' ? 'primary' : 'secondary',
    }));

    const results = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const selected = index % 2 === 0 ? binding : secondary;
      return service.invoke(
        selected.appId,
        selected.id,
        { orderId: `SO-${index}` },
        principal,
      );
    }));

    expect(results.filter((result: any) => result.marker === 'primary')).toHaveLength(50);
    expect(results.filter((result: any) => result.marker === 'secondary')).toHaveLength(50);
    expect(bridge.callTool).toHaveBeenCalledTimes(100);
    for (let index = 0; index < 100; index += 1) {
      expect(bridge.callTool).toHaveBeenNthCalledWith(
        index + 1,
        index % 2 === 0 ? 'mcp_erp_primary_orders' : 'mcp_erp_secondary_orders',
        { orderId: `SO-${index}` },
        principal,
      );
    }
  });

  test('resolves the ToolBridge token from the host module at invocation time', async () => {
    const bridge = { callTool: jest.fn().mockResolvedValue({ marker: 'resolved' }) };
    const binding = {
      id: '9aaeece3-3160-49a5-953f-cdf346bd156f',
      appId: 'com.example.app',
      connectionName: 'erp_primary',
      toolName: 'orders',
      inputSchemaDigest: '',
      config: {},
      enabled: true,
      createdBy: 'user:admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM jz_app_connection_bindings')) return { rows: [binding] };
        if (sql.includes('FROM jz_app_connection_binding_grants')) return { rows: [] };
        return { rows: [] };
      }),
    };
    const mcpRegistry = {
      get: jest.fn().mockReturnValue({
        name: 'erp_primary',
        enabled: true,
        tools: [{ name: 'orders', description: 'Orders', inputSchema }],
      }),
      isAllowedForUser: jest.fn().mockReturnValue(true),
    };
    class BindingTestModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [{
        module: BindingTestModule,
        providers: [
          AppConnectionBindingService,
          { provide: DbService, useValue: db },
          { provide: AppRegistryService, useValue: {} },
          { provide: AppGrantService, useValue: { hasAppAccessForPrincipal: jest.fn().mockResolvedValue(true) } },
          { provide: AppServicePrincipalService, useValue: {} },
          { provide: McpRegistryService, useValue: mcpRegistry },
        ],
        exports: [AppConnectionBindingService],
      }],
      providers: [{ provide: TOOL_BRIDGE, useValue: bridge }],
    }).compile();
    const service = moduleRef.get(AppConnectionBindingService);
    binding.inputSchemaDigest = (service as any).schemaDigest(inputSchema);

    await expect(service.invoke(
      binding.appId,
      binding.id,
      { orderId: 'SO-1' },
      principal,
    )).resolves.toEqual({ marker: 'resolved' });
    expect(bridge.callTool).toHaveBeenCalledWith(
      'mcp_erp_primary_orders',
      { orderId: 'SO-1' },
      principal,
    );

    await moduleRef.close();
  });
});
