import { AppContext } from './app-context';

describe('AppContext query contract', () => {
  it('returns the pg QueryResult object unchanged', async () => {
    const result = {
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      rows: [{ id: 'row-1' }],
      fields: [],
    };
    const query = jest.fn().mockResolvedValue(result);
    const context = new AppContext('com.test.query', undefined, {
      pools: { getPool: () => ({ query }) } as any,
    });

    await expect(context.query<{ id: string }>('SELECT id FROM rows')).resolves.toBe(result);
    expect(query).toHaveBeenCalledWith('SELECT id FROM rows', undefined);
  });

  it('passes the pg client through transactions', async () => {
    const client = { query: jest.fn() };
    const transaction = jest.fn(async (_appId, fn) => fn(client));
    const context = new AppContext('com.test.query', undefined, {
      pools: { transaction } as any,
    });

    await expect(context.transaction(async tx => tx === client)).resolves.toBe(true);
    expect(transaction).toHaveBeenCalledWith('com.test.query', expect.any(Function));
  });

  it('exposes only the host-provided connection client', async () => {
    const connections = {
      listBindings: jest.fn().mockResolvedValue([]),
      describe: jest.fn().mockResolvedValue({ id: 'binding-1' }),
      invoke: jest.fn().mockResolvedValue({ marker: 'erp-primary' }),
    };
    const context = new AppContext('com.test.query', undefined, {
      pools: {} as any,
      connections,
    });

    await expect(context.connections.invoke('binding-1', { orderId: 'SO-1' }))
      .resolves.toEqual({ marker: 'erp-primary' });
    expect(connections.invoke).toHaveBeenCalledWith('binding-1', { orderId: 'SO-1' });
  });

  it('fails explicitly when the host does not provide connection bindings', () => {
    const context = new AppContext('com.test.query', undefined, { pools: {} as any });

    expect(() => context.connections).toThrow('Connection binding service not available');
  });
});
