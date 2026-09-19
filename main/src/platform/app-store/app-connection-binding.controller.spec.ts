import { ForbiddenException } from '@nestjs/common';
import { InvocationContextFactory } from './runtime/invocation-context.factory';
import { AppConnectionBindingController } from './app-connection-binding.controller';

describe('AppConnectionBindingController', () => {
  let controller: AppConnectionBindingController;
  let bindings: any;

  const adminReq = {
    user: { id: 'admin-user', role: { id: 'admin', permissions: ['sys:admin'] } },
  };
  const regularReq = {
    user: { id: 'user-1', role: { id: 'planner', permissions: [] } },
  };

  beforeEach(() => {
    bindings = {
      listBindings: jest.fn().mockResolvedValue([]),
      createBinding: jest.fn().mockResolvedValue({ id: 'binding-1' }),
      describeBinding: jest.fn().mockResolvedValue({ id: 'binding-1' }),
      deleteBinding: jest.fn().mockResolvedValue(undefined),
      setEnabled: jest.fn().mockResolvedValue({ id: 'binding-1', enabled: false }),
      listGrants: jest.fn().mockResolvedValue([]),
      setGrant: jest.fn().mockResolvedValue({ id: 'grant-1' }),
      deleteGrant: jest.fn().mockResolvedValue(undefined),
      invoke: jest.fn().mockResolvedValue({ ok: true }),
    };
    controller = new AppConnectionBindingController(
      bindings,
      new InvocationContextFactory(),
    );
  });

  it.each([
    () => controller.list('com.example.app', regularReq),
    () => controller.create('com.example.app', { connectionName: 'erp', toolName: 'orders' }, regularReq),
    () => controller.describe('com.example.app', 'binding-1', regularReq),
    () => controller.remove('com.example.app', 'binding-1', regularReq),
    () => controller.setStatus('com.example.app', 'binding-1', { enabled: false }, regularReq),
    () => controller.listGrants('com.example.app', 'binding-1', regularReq),
    () => controller.setGrant(
      'com.example.app',
      'binding-1',
      { targetType: 'role', targetId: 'planner', effect: 'allow' },
      regularReq,
    ),
    () => controller.removeGrant('com.example.app', 'binding-1', 'role', 'planner', regularReq),
  ])('rejects non-administrators from binding management', async call => {
    await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(ForbiddenException);
    expect(bindings.listBindings).not.toHaveBeenCalled();
    expect(bindings.createBinding).not.toHaveBeenCalled();
    expect(bindings.describeBinding).not.toHaveBeenCalled();
    expect(bindings.deleteBinding).not.toHaveBeenCalled();
    expect(bindings.setEnabled).not.toHaveBeenCalled();
    expect(bindings.listGrants).not.toHaveBeenCalled();
    expect(bindings.setGrant).not.toHaveBeenCalled();
    expect(bindings.deleteGrant).not.toHaveBeenCalled();
  });

  it('passes route identity and the trusted administrator principal when creating a binding', async () => {
    const body = { connectionName: 'erp', toolName: 'orders' };

    await controller.create('com.example.app', body, adminReq);

    expect(bindings.createBinding).toHaveBeenCalledWith(
      'com.example.app',
      body,
      expect.objectContaining({
        principalId: 'user:admin-user',
        roleIds: ['admin'],
        permissions: ['sys:admin'],
      }),
    );
  });

  it('passes status and grant operations to the route-scoped binding', async () => {
    await controller.setStatus('com.example.app', 'binding-1', { enabled: false }, adminReq);
    await controller.setGrant(
      'com.example.app',
      'binding-1',
      { targetType: 'department', targetId: 'operations', effect: 'deny' },
      adminReq,
    );
    await controller.removeGrant(
      'com.example.app',
      'binding-1',
      'department',
      'operations',
      adminReq,
    );

    expect(bindings.setEnabled).toHaveBeenCalledWith('com.example.app', 'binding-1', false);
    expect(bindings.setGrant).toHaveBeenCalledWith(
      'com.example.app',
      'binding-1',
      { targetType: 'department', targetId: 'operations', effect: 'deny' },
    );
    expect(bindings.deleteGrant).toHaveBeenCalledWith(
      'com.example.app',
      'binding-1',
      'department',
      'operations',
    );
  });

  it('ignores body identity and invokes with the request principal', async () => {
    await controller.invoke(
      'com.example.app',
      'binding-1',
      { params: { orderId: 'SO-1' }, appId: 'forged', userId: 'forged' } as any,
      regularReq,
    );

    expect(bindings.invoke).toHaveBeenCalledWith(
      'com.example.app',
      'binding-1',
      { orderId: 'SO-1' },
      expect.objectContaining({
        principalId: 'user:user-1',
        roleIds: ['planner'],
      }),
    );
  });
});
