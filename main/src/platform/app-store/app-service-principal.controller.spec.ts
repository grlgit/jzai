import { ForbiddenException } from '@nestjs/common';
import { InvocationContextFactory } from './runtime/invocation-context.factory';
import { AppServicePrincipalController } from './app-service-principal.controller';

describe('AppServicePrincipalController', () => {
  let controller: AppServicePrincipalController;
  let service: any;

  const adminReq = {
    user: { id: 'admin-user', role: { id: 'admin', permissions: ['sys:admin'] } },
  };
  const regularReq = {
    user: { id: 'regular-user', role: { id: 'planner', permissions: [] } },
  };

  beforeEach(() => {
    service = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'service-1' }),
      revoke: jest.fn().mockResolvedValue(undefined),
      createDelegation: jest.fn().mockResolvedValue({ id: 'delegation-1' }),
      revokeDelegation: jest.fn().mockResolvedValue(undefined),
    };
    controller = new AppServicePrincipalController(
      service,
      new InvocationContextFactory(),
    );
  });

  it.each([
    () => controller.list('com.example.app', regularReq),
    () => controller.create('com.example.app', { name: 'worker', scopes: [] }, regularReq),
    () => controller.revoke('com.example.app', 'service-1', regularReq),
    () => controller.createDelegation(
      'com.example.app',
      'service-1',
      { userId: 'user-1', scopes: [], expiresAt: '2030-01-01T00:00:00.000Z' },
      regularReq,
    ),
    () => controller.revokeDelegation('com.example.app', 'delegation-1', regularReq),
  ])('rejects non-administrators before invoking the service', async call => {
    await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
    expect(service.revoke).not.toHaveBeenCalled();
    expect(service.createDelegation).not.toHaveBeenCalled();
    expect(service.revokeDelegation).not.toHaveBeenCalled();
  });

  it('passes the trusted administrator principal to service principal creation', async () => {
    await controller.create(
      'com.example.app',
      { name: 'worker', scopes: ['connection:invoke'] },
      adminReq,
    );

    expect(service.create).toHaveBeenCalledWith(
      'com.example.app',
      { name: 'worker', scopes: ['connection:invoke'] },
      expect.objectContaining({
        principalId: 'user:admin-user',
        roleIds: ['admin'],
        permissions: ['sys:admin'],
      }),
    );
  });

  it('uses route identifiers for revocation and delegation operations', async () => {
    await controller.revoke('com.example.app', 'service-1', adminReq);
    await controller.createDelegation(
      'com.example.app',
      'service-1',
      { userId: 'user-1', scopes: ['connection:invoke'], expiresAt: '2030-01-01T00:00:00.000Z' },
      adminReq,
    );
    await controller.revokeDelegation('com.example.app', 'delegation-1', adminReq);

    expect(service.revoke).toHaveBeenCalledWith('com.example.app', 'service-1');
    expect(service.createDelegation).toHaveBeenCalledWith(
      'com.example.app',
      'service-1',
      { userId: 'user-1', scopes: ['connection:invoke'], expiresAt: '2030-01-01T00:00:00.000Z' },
    );
    expect(service.revokeDelegation).toHaveBeenCalledWith('com.example.app', 'delegation-1');
  });
});
