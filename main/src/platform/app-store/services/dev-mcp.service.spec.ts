import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DevMcpService } from './dev-mcp.service';
import { AppAuditService } from './app-audit.service';

function createTokenService() {
  const rows = new Map<string, string>(); // key -> value_enc (plain JSON via passthrough crypto)
  const db = {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith('INSERT INTO jz_credentials')) {
        rows.set(params[1], params[2]);
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM jz_credentials WHERE scope=$1 AND key=$2')) {
        rows.delete(params[1]);
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM jz_credentials WHERE scope=$1')) {
        rows.clear();
        return { rows: [] };
      }
      if (sql.startsWith('SELECT value_enc FROM jz_credentials')) {
        return { rows: [...rows.values()].map(v => ({ value_enc: v })) };
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
  };
  const credentials = {
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new DevMcpService(
    db as any,
    {} as any,
    { findAll: jest.fn().mockResolvedValue([]) } as any,
    audit as any,
    credentials as any,
    {} as any,
  );
  return { service, db, audit, rows };
}

describe('DevMcpService dev token', () => {
  it('issues token with stable tokenId and never stores the raw token', async () => {
    const { service, rows } = createTokenService();
    const { token, tokenId } = await service.issueToken('admin-1');
    expect(token).toMatch(/^jzdev_[0-9a-f]{48}$/);
    expect(tokenId).toMatch(/^dtok_[0-9a-f]{8}$/);
    for (const stored of rows.values()) {
      expect(stored).not.toContain(token);
    }
  });

  it('verifies token to tokenId/scopes and rejects unknown token', async () => {
    const { service } = createTokenService();
    const { token, tokenId } = await service.issueToken('admin-1', ['read']);
    const verified = await service.verifyToken(token);
    expect(verified).toEqual({ tokenId, scopes: ['read'] });
    await expect(service.verifyToken('jzdev_' + '0'.repeat(48))).resolves.toBeNull();
    await expect(service.verifyToken(undefined)).resolves.toBeNull();
  });

  it('supports multiple tokens and revokes by tokenId only', async () => {
    const { service } = createTokenService();
    const a = await service.issueToken('admin-1');
    const b = await service.issueToken('admin-1');
    await service.revokeToken('admin-1', a.tokenId);
    await expect(service.verifyToken(a.token)).resolves.toBeNull();
    await expect(service.verifyToken(b.token)).resolves.toEqual({
      tokenId: b.tokenId,
      scopes: ['read', 'invoke', 'manage'],
    });
    const status = await service.getTokenStatus();
    expect(status.tokens.map(t => t.tokenId)).toEqual([b.tokenId]);
  });

  it('revokes all tokens when tokenId omitted', async () => {
    const { service } = createTokenService();
    const a = await service.issueToken('admin-1');
    await service.issueToken('admin-1');
    await service.revokeToken('admin-1');
    await expect(service.verifyToken(a.token)).resolves.toBeNull();
    expect((await service.getTokenStatus()).issued).toBe(false);
  });

  it('audits issuance with tokenId and scopes', async () => {
    const { service, audit } = createTokenService();
    const { tokenId } = await service.issueToken('admin-1', ['read', 'invoke']);
    expect(audit.log).toHaveBeenCalledWith('dev-mcp', 'dev_token_issue', 'admin-1', {
      tokenId,
      scopes: ['read', 'invoke'],
    });
  });
});

describe('AppAuditService redaction', () => {
  it('redacts sensitive keys and raw dev tokens in payload', async () => {
    const queries: Array<[string, any[]]> = [];
    const db = {
      query: jest.fn(async (sql: string, params: any[]) => {
        queries.push([sql, params]);
        return { rows: [] };
      }),
    };
    const audit = new AppAuditService(db as any);
    const rawToken = `jzdev_${'a'.repeat(48)}`;
    await audit.log('app', 'dev_mcp_call', 'dev-mcp:dtok_1234abcd', {
      tokenId: 'dtok_1234abcd',
      nested: { apiKey: 'k', password: 'p', authorization: 'Bearer x', token: rawToken },
      list: [rawToken, 'plain'],
    });
    const detail = JSON.parse(queries[0][1][3]);
    expect(detail.tokenId).toBe('dtok_1234abcd');
    expect(detail.nested).toEqual({
      apiKey: '[redacted]',
      password: '[redacted]',
      authorization: '[redacted]',
      token: '[redacted]',
    });
    expect(detail.list).toEqual(['[redacted]', 'plain']);
    expect(JSON.stringify(detail)).not.toContain(rawToken);
  });
});

describe('DevMcpService resources', () => {
  let root: string;
  let service: DevMcpService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-mcp-resource-'));
    fs.mkdirSync(path.join(root, 'docs', 'patterns'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'patterns', 'async-job.md'), '# async job');
    service = new DevMcpService(
      {} as any,
      {} as any,
      { findAll: jest.fn().mockResolvedValue([{ status: 'active', installDir: root, manifest: { platformCapabilities: ['appstore:manage'] } }]) } as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists and reads canonical Markdown resource URIs', async () => {
    const resources = await service.listResources();
    expect(resources).toContainEqual(expect.objectContaining({ uri: 'jzdev://docs/patterns/async-job.md' }));
    await expect(service.readResource('jzdev://docs/patterns/async-job.md')).resolves.toEqual(
      expect.objectContaining({ uri: 'jzdev://docs/patterns/async-job.md', text: '# async job' }),
    );
  });

  it('keeps extensionless resource references backward compatible', async () => {
    await expect(service.readResource('jzdev://docs/patterns/async-job')).resolves.toEqual(
      expect.objectContaining({ uri: 'jzdev://docs/patterns/async-job.md', text: '# async job' }),
    );
  });
});
