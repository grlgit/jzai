import { AppSchemaService } from './app-schema.service';

describe('AppSchemaService', () => {
  it('creates the role using PostgreSQL format rather than a DDL bind parameter', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{ statement: `CREATE ROLE "app_dim_tuner_role" LOGIN PASSWORD 'safe-password' NOINHERIT` }],
        })
        .mockResolvedValue({ rows: [] }),
    };
    const db = {
      transaction: jest.fn(async callback => callback(client)),
    };
    const service = new AppSchemaService(db as any);
    const manifest = {
      appId: 'com.menhu.drawing.dimtuner',
      database: {
        schemaName: 'app_dim_tuner',
        statementTimeoutMs: 30000,
        poolMax: 3,
      },
    } as any;

    await service.createSchemaAndRole(manifest, 'safe-password');

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', $1::text, $2::text) AS statement`,
      ['app_dim_tuner_role', 'safe-password'],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      `CREATE ROLE "app_dim_tuner_role" LOGIN PASSWORD 'safe-password' NOINHERIT`,
    );
  });

  it('rotates credentials only for a retained schema owned by its app role', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{ statement: `ALTER ROLE "app_dim_tuner_role" LOGIN PASSWORD 'new-password' NOINHERIT` }],
        })
        .mockResolvedValue({ rows: [] }),
    };
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{ roleExists: true, schemaExists: true, schemaOwner: 'app_dim_tuner_role' }],
        })
        .mockResolvedValueOnce({ rows: [{ unsafe: false }] }),
      transaction: jest.fn(async callback => callback(client)),
    };
    const service = new AppSchemaService(db as any);
    const manifest = {
      appId: 'com.menhu.drawing.dimtuner',
      database: { schemaName: 'app_dim_tuner' },
    } as any;

    await service.restoreSchemaAndRole(manifest, 'new-password');

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOINHERIT', $1::text, $2::text) AS statement`,
      ['app_dim_tuner_role', 'new-password'],
    );
    expect(client.query).toHaveBeenCalledWith(`ALTER ROLE "app_dim_tuner_role" SET search_path = "app_dim_tuner"`);
  });

  it('does not purge a schema owned by another role', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [{ roleExists: true, schemaExists: true, schemaOwner: 'unrelated_owner' }],
      }),
    };
    const service = new AppSchemaService(db as any);
    const manifest = {
      appId: 'com.menhu.drawing.dimtuner',
      database: { schemaName: 'app_dim_tuner' },
    } as any;

    await expect(service.purgeOrphanedResources(manifest)).rejects.toThrow('所有者不匹配');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
