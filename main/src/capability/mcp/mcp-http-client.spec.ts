import * as http from 'http';
import { AddressInfo } from 'net';
import { McpHttpClient } from './mcp-http-client';

describe('McpHttpClient session isolation', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    McpHttpClient.clearAllSessions();
    server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      const cookieValue = requestUrl.searchParams.get('cookie');
      if (cookieValue) {
        res.setHeader('Set-Cookie', `session=${cookieValue}; Path=/; HttpOnly`);
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    McpHttpClient.clearAllSessions();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('isolates cookies by principal and connector', async () => {
    const first = new McpHttpClient('user:one', 'erp');
    const second = new McpHttpClient('user:one', 'mes');
    const third = new McpHttpClient('user:two', 'erp');

    await first.get(`${baseUrl}/set?cookie=erp-one`);
    await second.get(`${baseUrl}/set?cookie=mes-one`);
    await third.get(`${baseUrl}/set?cookie=erp-two`);

    await expect(first.get(`${baseUrl}/read`)).resolves.toMatchObject({
      data: { cookie: 'session=erp-one' },
    });
    await expect(second.get(`${baseUrl}/read`)).resolves.toMatchObject({
      data: { cookie: 'session=mes-one' },
    });
    await expect(third.get(`${baseUrl}/read`)).resolves.toMatchObject({
      data: { cookie: 'session=erp-two' },
    });
  });

  it('clears only the requested principal and connector session', async () => {
    const cleared = new McpHttpClient('user:one', 'erp');
    const retained = new McpHttpClient('user:one', 'mes');
    await cleared.get(`${baseUrl}/set?cookie=erp-one`);
    await retained.get(`${baseUrl}/set?cookie=mes-one`);

    McpHttpClient.clearPrincipalConnectionSessions('user:one', 'erp');

    await expect(cleared.get(`${baseUrl}/read`)).resolves.toMatchObject({
      data: { cookie: '' },
    });
    await expect(retained.get(`${baseUrl}/read`)).resolves.toMatchObject({
      data: { cookie: 'session=mes-one' },
    });
  });
});
