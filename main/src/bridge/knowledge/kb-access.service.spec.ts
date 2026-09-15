import { KbAccessService } from './kb-access.service';

describe('KbAccessService', () => {
  let service: KbAccessService;
  let mockDb: { query: jest.Mock };

  beforeEach(() => {
    mockDb = { query: jest.fn() };
    service = new KbAccessService(mockDb as any);
  });

  it('returns ADMIN_ALL for sys:admin', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ role_id: 'admin', permissions: ['sys:admin', 'kb:read'] }],
    });

    const scopes = await service.getAccessibleScopesForUser('user-1');
    expect(scopes).toBe('ADMIN_ALL');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('returns ADMIN_ALL for kb:admin', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ role_id: 'kb_admin', permissions: ['kb:admin', 'kb:read'] }],
    });

    const scopes = await service.getAccessibleScopesForUser('user-1');
    expect(scopes).toBe('ADMIN_ALL');
  });

  it('returns empty array when user does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const scopes = await service.getAccessibleScopesForUser('missing');
    expect(scopes).toEqual([]);
  });

  it('returns granted category ids for a normal user', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'user', permissions: ['kb:read'] }],
      })
      .mockResolvedValueOnce({
        rows: [{ category_id: 'cat-a' }, { category_id: 'cat-b' }],
      });

    const scopes = await service.getAccessibleScopesForUser('user-1');
    expect(scopes).toEqual(['cat-a', 'cat-b']);
  });

  it('returns empty array when no grants exist', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'user', permissions: ['kb:read'] }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const scopes = await service.getAccessibleScopesForUser('user-1');
    expect(scopes).toEqual([]);
  });

  it('passes user id to recursive grant query', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ role_id: 'user', permissions: ['kb:read'] }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await service.getAccessibleScopesForUser('user-1');
    const grantQuery = mockDb.query.mock.calls[1][1];
    expect(grantQuery).toEqual(['user-1']);
  });
});
