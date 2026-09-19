import { AppCredentialService } from './app-credential.service';
import { AppManifest } from '../validators/manifest.schema';

const manifest = {
  configSchema: {
    fields: [
      { key: 'solverApiKey', type: 'secret', label: { zh: 'Solver Key' } },
      { key: 'endpoint', type: 'string', label: { zh: 'Endpoint' } },
    ],
  },
} as unknown as AppManifest;

function createService() {
  const rows = new Map<string, string>(); // `${scope}|${key}` -> value_enc
  const db = {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith('INSERT INTO jz_credentials')) {
        rows.set(`${params[0]}|${params[1]}`, params[2]);
        return { rows: [] };
      }
      if (sql.startsWith('SELECT value_enc FROM jz_credentials')) {
        const v = rows.get(`${params[0]}|${params[1]}`);
        return { rows: v ? [{ value_enc: v }] : [] };
      }
      if (sql.startsWith('SELECT key FROM jz_credentials')) {
        const prefix = `${params[0]}|`;
        return { rows: [...rows.keys()].filter(k => k.startsWith(prefix)).map(k => ({ key: k.slice(prefix.length) })) };
      }
      if (sql.startsWith('DELETE FROM jz_credentials WHERE scope=$1 AND key=$2')) {
        rows.delete(`${params[0]}|${params[1]}`);
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM jz_credentials WHERE scope=$1')) {
        const prefix = `${params[0]}|`;
        for (const k of [...rows.keys()]) if (k.startsWith(prefix)) rows.delete(k);
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
  };
  const credentialService = {
    encrypt: (v: string) => `enc(${v})`,
    decrypt: (v: string) => v.replace(/^enc\(|\)$/g, ''),
  };
  const service = new AppCredentialService(db as any, {} as any, credentialService as any);
  return { service, rows };
}

describe('AppCredentialService', () => {
  it('extracts plaintext secrets into store and replaces with secret:// refs', async () => {
    const { service, rows } = createService();
    const out = await service.extractAndStoreSecrets('com.example.ps', {
      solverApiKey: 'sk-live-123',
      endpoint: 'https://solver.internal',
    }, manifest);
    expect(out).toEqual({
      solverApiKey: 'secret://com.example.ps/solverApiKey',
      endpoint: 'https://solver.internal',
    });
    expect(rows.get('app:com.example.ps|solverApiKey')).toBe('enc(sk-live-123)');
    expect(JSON.stringify(out)).not.toContain('sk-live-123');
  });

  it('is idempotent for existing secret:// refs and clears empty values', async () => {
    const { service, rows } = createService();
    await service.setSecret('com.example.ps', 'solverApiKey', 'old');
    const out = await service.extractAndStoreSecrets('com.example.ps', {
      solverApiKey: '',
    }, manifest);
    expect(out.solverApiKey).toBeNull();
    expect(rows.has('app:com.example.ps|solverApiKey')).toBe(false);

    const kept = await service.extractAndStoreSecrets('com.example.ps', {
      solverApiKey: 'secret://com.example.ps/solverApiKey',
    }, manifest);
    expect(kept.solverApiKey).toBe('secret://com.example.ps/solverApiKey');
  });

  it('resolves refs to real values and fails closed on missing secrets', async () => {
    const { service } = createService();
    await service.setSecret('com.example.ps', 'solverApiKey', 'sk-live-123');
    const resolved = await service.resolveConfig('com.example.ps', {
      solverApiKey: 'secret://com.example.ps/solverApiKey',
      endpoint: 'https://solver.internal',
    });
    expect(resolved).toEqual({
      solverApiKey: 'sk-live-123',
      endpoint: 'https://solver.internal',
    });
    await expect(service.resolveConfig('com.example.ps', {
      solverApiKey: 'secret://com.example.ps/deleted',
    })).rejects.toThrow(/Secret not found/);
  });

  it('masks secret fields to configured flags only', async () => {
    const { service } = createService();
    const masked = service.maskConfig({
      solverApiKey: 'secret://com.example.ps/solverApiKey',
      endpoint: 'https://solver.internal',
    }, manifest);
    expect(masked).toEqual({
      solverApiKey: '[configured]',
      endpoint: 'https://solver.internal',
    });
  });

  it('lists and deletes all secrets for an app', async () => {
    const { service } = createService();
    await service.setSecret('com.example.ps', 'a', '1');
    await service.setSecret('com.example.ps', 'b', '2');
    await service.setSecret('com.other.app', 'a', 'x');
    await expect(service.listSecretKeys('com.example.ps')).resolves.toEqual(['a', 'b']);
    await service.deleteAllSecrets('com.example.ps');
    await expect(service.listSecretKeys('com.example.ps')).resolves.toEqual([]);
    await expect(service.listSecretKeys('com.other.app')).resolves.toEqual(['a']);
  });
});
