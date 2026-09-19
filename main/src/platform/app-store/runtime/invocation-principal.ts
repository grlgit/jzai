export type InvocationPrincipalType = 'user' | 'delegated' | 'service' | 'dev-mcp' | 'system';

export interface InvocationPrincipal {
  readonly type: InvocationPrincipalType;
  readonly principalId: string;
  readonly userId?: string;
  readonly roleIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
  readonly origin: string;
  readonly delegatedBy?: string;
  readonly servicePrincipalId?: string;
  readonly tokenId?: string;
  readonly issuedAt: number;
  readonly expiresAt?: number;
}

export type InvocationPrincipalInput = InvocationPrincipal | string | undefined;

export interface UserPrincipalSource {
  id: string;
  role?: { id?: string; permissions?: readonly string[] };
  roleId?: string;
  permissions?: readonly string[];
  departmentIds?: readonly string[];
  tokenId?: string;
  issuedAt?: number;
  expiresAt?: number;
}

function freezeStrings(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze(Array.from(new Set(values ?? [])));
}

export function createInvocationPrincipal(
  value: Omit<InvocationPrincipal, 'roleIds' | 'departmentIds' | 'permissions' | 'scopes'> & {
    roleIds?: readonly string[];
    departmentIds?: readonly string[];
    permissions?: readonly string[];
    scopes?: readonly string[];
  },
): InvocationPrincipal {
  return Object.freeze({
    ...value,
    roleIds: freezeStrings(value.roleIds),
    departmentIds: freezeStrings(value.departmentIds),
    permissions: freezeStrings(value.permissions),
    scopes: freezeStrings(value.scopes),
  });
}

export function createUserPrincipal(user: UserPrincipalSource, origin: string): InvocationPrincipal {
  const roleId = user.role?.id ?? user.roleId;
  return createInvocationPrincipal({
    type: 'user',
    principalId: `user:${user.id}`,
    userId: user.id,
    roleIds: roleId ? [roleId] : [],
    departmentIds: user.departmentIds,
    permissions: user.role?.permissions ?? user.permissions,
    scopes: [],
    origin,
    tokenId: user.tokenId,
    issuedAt: user.issuedAt ?? Date.now(),
    expiresAt: user.expiresAt,
  });
}

export function createServicePrincipal(
  appId: string,
  name: string,
  scopes: readonly string[],
  origin = `app:${appId}`,
): InvocationPrincipal {
  return createInvocationPrincipal({
    type: 'service',
    principalId: `service:${appId}:${name}`,
    scopes,
    origin,
    issuedAt: Date.now(),
  });
}

export function createDevMcpPrincipal(actorId: string): InvocationPrincipal {
  return createInvocationPrincipal({
    type: 'dev-mcp',
    principalId: actorId.startsWith('dev-mcp:') ? actorId : `dev-mcp:${actorId}`,
    scopes: ['app:invoke'],
    origin: 'dev-mcp',
    issuedAt: Date.now(),
  });
}

export function createSystemPrincipal(origin: string, scopes: readonly string[] = []): InvocationPrincipal {
  return createInvocationPrincipal({
    type: 'system',
    principalId: `system:${origin}`,
    scopes,
    origin,
    issuedAt: Date.now(),
  });
}

export function normalizeInvocationPrincipal(
  input: InvocationPrincipalInput,
  origin = 'legacy',
): InvocationPrincipal | undefined {
  if (!input) return undefined;
  if (typeof input !== 'string') return input;
  return createInvocationPrincipal({
    type: 'user',
    principalId: `user:${input}`,
    userId: input,
    origin,
    issuedAt: Date.now(),
  });
}

export function principalHasScope(principal: InvocationPrincipal, scope: string): boolean {
  return principal.scopes.includes('*') || principal.scopes.includes(scope);
}

export function principalIsExpired(principal: InvocationPrincipal): boolean {
  return principal.expiresAt !== undefined && principal.expiresAt <= Date.now();
}
