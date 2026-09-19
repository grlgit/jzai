import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AppServicePrincipalService } from './app-service-principal.service';

function createFixture() {
  const db = { query: jest.fn() };
  const registry = { findOne: jest.fn().mockResolvedValue({ appId: 'com.example.app' }) };
  const service = new AppServicePrincipalService(db as any, registry as any);
  return { service, db, registry };
}

describe('AppServicePrincipalService', () => {
  test('resolves a persisted service principal with its stable database identity', async () => {
    const { service, db } = createFixture();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'sp-1',
        appId: 'com.example.app',
        name: 'scheduler',
        scopes: ['connection:invoke'],
        expiresAt: new Date(Date.now() + 60_000),
      }],
    });

    await expect(service.resolveService('com.example.app', 'sp-1', 'job:test'))
      .resolves.toEqual(expect.objectContaining({
        type: 'service',
        principalId: 'service:sp-1',
        servicePrincipalId: 'sp-1',
        scopes: ['connection:invoke'],
      }));
  });

  test('rejects revoked or expired service principals immediately', async () => {
    const { service, db } = createFixture();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'sp-1',
        appId: 'com.example.app',
        scopes: ['connection:invoke'],
        revokedAt: new Date(),
      }],
    });

    await expect(service.resolveService('com.example.app', 'sp-1', 'job:test'))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  test('rejects service principals owned by another app', async () => {
    const { service, db } = createFixture();
    db.query.mockResolvedValueOnce({ rows: [] });

    await expect(service.assertOwnedByApp('com.example.app', 'foreign'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  test('prevents delegation scope escalation', async () => {
    const { service, db } = createFixture();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'sp-1',
        appId: 'com.example.app',
        scopes: ['connection:binding-1:invoke'],
      }],
    });

    await expect(service.createDelegation(
      'com.example.app',
      'sp-1',
      {
        userId: 'user-1',
        scopes: ['connection:invoke'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  test('revalidates delegation and intersects it with current service scopes', async () => {
    const { service, db } = createFixture();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'delegation-1',
        servicePrincipalId: 'sp-1',
        delegatedByUserId: 'user-1',
        scopes: ['connection:invoke', 'removed:scope'],
        expiresAt: new Date(Date.now() + 60_000),
        appId: 'com.example.app',
        serviceScopes: ['connection:invoke'],
        userStatus: 'active',
        roleId: 'planner',
        permissions: ['schedule:read'],
        departmentIds: ['plant-1'],
      }],
    });

    await expect(service.resolveDelegation('com.example.app', 'delegation-1', 'job:test'))
      .resolves.toEqual(expect.objectContaining({
        type: 'delegated',
        principalId: 'delegation:delegation-1',
        userId: 'user-1',
        servicePrincipalId: 'sp-1',
        roleIds: ['planner'],
        departmentIds: ['plant-1'],
        permissions: ['schedule:read'],
        scopes: ['connection:invoke'],
      }));
  });
});
