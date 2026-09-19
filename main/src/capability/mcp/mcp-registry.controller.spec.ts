import { McpRegistryController } from './mcp-registry.controller';

const connector = (name: string) => ({
  name,
  system: name,
  description: `${name} connector`,
  tools: [{ name: 'query', description: 'Query' }],
  enabled: true,
  permissions: {},
  status: { phase: 'available' },
  authFields: [],
});

describe('McpRegistryController', () => {
  let controller: McpRegistryController;
  let mcp: any;

  beforeEach(() => {
    mcp = {
      getAll: jest.fn().mockReturnValue([
        connector('allowed'),
        connector('denied'),
      ]),
      isAllowedForUser: jest.fn((name: string) => name === 'allowed'),
    };
    controller = new McpRegistryController(
      mcp,
      {} as any,
      { resolveCredentials: jest.fn().mockReturnValue({}) } as any,
      { verifyToken: jest.fn() } as any,
    );
  });

  it('shows users only connectors allowed to their current identity', () => {
    const result = controller.list({
      user: {
        id: 'user-1',
        role: { id: 'planner', permissions: [] },
        roles: [{ id: 'reviewer' }],
      },
      headers: {},
    });

    expect(result.map(item => item.name)).toEqual(['allowed']);
    expect(mcp.isAllowedForUser).toHaveBeenNthCalledWith(
      1,
      'allowed',
      'user-1',
      ['planner', 'reviewer'],
    );
    expect(mcp.isAllowedForUser).toHaveBeenNthCalledWith(
      2,
      'denied',
      'user-1',
      ['planner', 'reviewer'],
    );
  });

  it('allows an authenticated administrator to discover all connectors', () => {
    const result = controller.list({
      user: {
        id: 'admin-1',
        role: { id: 'admin', permissions: ['sys:admin'] },
      },
      headers: {},
    });

    expect(result.map(item => item.name)).toEqual(['allowed', 'denied']);
    expect(mcp.isAllowedForUser).not.toHaveBeenCalled();
  });
});
