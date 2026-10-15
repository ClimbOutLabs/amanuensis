import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createRequestGuardMiddleware } from '../../../src/auth/requestGuard';

function appFor(options: { port: number; publicBaseUrl: string }) {
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.text('boom', 500),
  );
  app.use('*', createRequestGuardMiddleware(options));
  app.all('*', c => c.text('ok'));
  return app;
}

const LOCAL = { port: 8790, publicBaseUrl: 'http://localhost:8790' };
const PUBLIC = { port: 8790, publicBaseUrl: 'https://amanuensis.example' };

async function status(options: {
  app: Hono;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
}): Promise<number> {
  const res = await options.app.request(options.path ?? '/api/v1/sessions', {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
  });
  return res.status;
}

describe('request guard: Host', () => {
  it.each(['localhost:8790', '127.0.0.1:8790', '[::1]:8790', 'LOCALHOST:8790'])(
    'accepts loopback host %s',
    async host => {
      expect(await status({ app: appFor(LOCAL), headers: { host } })).toBe(200);
    },
  );

  it.each([
    'evil.example',
    'evil.example:8790',
    'localhost:9999',
    'localhost',
    'localhost.evil.example:8790',
    '10.0.0.5:8790',
  ])('rejects %s with 421', async host => {
    expect(await status({ app: appFor(LOCAL), headers: { host } })).toBe(421);
  });

  it('accepts the public host with and without its default port, and loopback on the instance port', async () => {
    const app = appFor(PUBLIC);
    expect(await status({ app, headers: { host: 'amanuensis.example' } })).toBe(200);
    expect(await status({ app, headers: { host: 'amanuensis.example:443' } })).toBe(200);
    expect(await status({ app, headers: { host: 'localhost:8790' } })).toBe(200);
    expect(await status({ app, headers: { host: 'other.example' } })).toBe(421);
  });

  it('accepts a mapped loopback public port and ignores forwarded headers', async () => {
    const app = appFor({ port: 8790, publicBaseUrl: 'http://localhost:18790' });
    expect(await status({ app, headers: { host: 'localhost:18790' } })).toBe(200);
    expect(await status({ app, headers: { host: 'evil.example', 'x-forwarded-host': 'localhost:18790' } })).toBe(421);
  });

  it('rejects a malformed Host header', async () => {
    expect(await status({ app: appFor(LOCAL), headers: { host: 'localhost:8790/evil' } })).toBe(421);
  });

  it('applies to every method and path except /healthz', async () => {
    const app = appFor(LOCAL);
    expect(await status({ app, path: '/api/v1/auth/login', headers: { host: 'evil.example' } })).toBe(421);
    expect(await status({ app, path: '/healthz', headers: { host: 'evil.example' } })).toBe(200);
  });
});

describe('request guard: loopback public URL', () => {
  const app = () => appFor({ port: 8790, publicBaseUrl: 'http://127.0.0.1:18790' });

  it.each(['127.0.0.1:18790', 'localhost:18790', '[::1]:18790', 'LOCALHOST:18790'])(
    'accepts %s on the public port',
    async host => {
      expect(await status({ app: app(), headers: { host } })).toBe(200);
    },
  );

  it('still accepts every loopback name on the instance port', async () => {
    expect(await status({ app: app(), headers: { host: 'localhost:8790' } })).toBe(200);
  });

  it.each([
    'evil.example:18790',
    'localhost.evil.com:18790',
    '10.0.0.5:18790',
    'localhost:9999',
    '[::1]:9999',
    'localhost',
  ])('rejects %s with 421', async host => {
    expect(await status({ app: app(), headers: { host } })).toBe(421);
  });

  it.each(['http://127.0.0.1:18790', 'http://localhost:18790', 'http://[::1]:18790'])(
    'accepts Origin %s on writes',
    async origin => {
      expect(await status({ app: app(), method: 'POST', headers: { host: 'localhost:18790', origin } })).toBe(200);
    },
  );

  it.each(['http://localhost:9999', 'https://localhost:18790', 'http://evil.example:18790'])(
    'rejects Origin %s on writes',
    async origin => {
      expect(await status({ app: app(), method: 'POST', headers: { host: 'localhost:18790', origin } })).toBe(403);
    },
  );

  it('does not widen a non-loopback public URL to loopback names on its port', async () => {
    const remote = appFor({ port: 8790, publicBaseUrl: 'https://amanuensis.example:9443' });
    expect(await status({ app: remote, headers: { host: 'localhost:9443' } })).toBe(421);
    expect(
      await status({
        app: remote,
        method: 'POST',
        headers: { host: 'localhost:8790', origin: 'https://localhost:9443' },
      }),
    ).toBe(403);
  });
});

describe('request guard: Origin', () => {
  const host = { host: 'amanuensis.example' };

  it('accepts a same-origin Origin on writes, public or loopback', async () => {
    const app = appFor(PUBLIC);
    expect(await status({ app, method: 'POST', headers: { ...host, origin: 'https://amanuensis.example' } })).toBe(200);
    expect(
      await status({ app, method: 'DELETE', headers: { host: 'localhost:8790', origin: 'http://localhost:8790' } }),
    ).toBe(200);
  });

  it.each(['https://evil.example', 'null', 'http://amanuensis.example', 'https://amanuensis.example.evil.example'])(
    'rejects cross-origin Origin %s',
    async origin => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(await status({ app: appFor(PUBLIC), method, headers: { ...host, origin } })).toBe(403);
      }
    },
  );

  it('uses Sec-Fetch-Site when Origin is absent', async () => {
    const app = appFor(PUBLIC);
    expect(await status({ app, method: 'POST', headers: { ...host, 'sec-fetch-site': 'same-origin' } })).toBe(200);
    expect(await status({ app, method: 'POST', headers: { ...host, 'sec-fetch-site': 'none' } })).toBe(200);
    expect(await status({ app, method: 'POST', headers: { ...host, 'sec-fetch-site': 'cross-site' } })).toBe(403);
    expect(await status({ app, method: 'POST', headers: { ...host, 'sec-fetch-site': 'same-site' } })).toBe(403);
    expect(await status({ app, method: 'POST', headers: host })).toBe(403);
  });

  it('lets Bearer clients write without Origin or Sec-Fetch-Site', async () => {
    const app = appFor(PUBLIC);
    expect(await status({ app, method: 'POST', headers: { ...host, authorization: 'Bearer abc' } })).toBe(200);
    expect(await status({ app, method: 'POST', headers: { ...host, authorization: 'Basic abc' } })).toBe(403);
  });

  it('a Bearer header does not excuse a foreign Origin', async () => {
    const app = appFor(PUBLIC);
    expect(
      await status({
        app,
        method: 'POST',
        headers: { ...host, authorization: 'Bearer abc', origin: 'https://evil.example' },
      }),
    ).toBe(403);
  });

  it('does not check reads', async () => {
    const app = appFor(PUBLIC);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(await status({ app, method, headers: { ...host, origin: 'https://evil.example' } })).toBe(200);
    }
  });

  it.each(['/healthz', '/api/internal/schedules/abc/execute', '/api/v1/mcp-servers/oauth/callback'])(
    'exempts %s from the Origin check but not the Host check',
    async path => {
      const app = appFor(PUBLIC);
      expect(await status({ app, path, method: 'POST', headers: { ...host, origin: 'https://evil.example' } })).toBe(
        200,
      );
      expect(await status({ app, path, method: 'POST', headers: { host: 'evil.example' } })).toBe(
        path === '/healthz' ? 200 : 421,
      );
    },
  );

  it('does not exempt look-alike paths', async () => {
    const app = appFor(PUBLIC);
    expect(
      await status({
        app,
        path: '/api/internal/schedules-evil',
        method: 'POST',
        headers: { ...host, origin: 'https://evil.example' },
      }),
    ).toBe(403);
  });
});

describe('request guard: instance opened on the local network', () => {
  const app = () => appFor({ port: 8790, publicBaseUrl: 'http://192.168.1.20:18791' });

  it.each(['192.168.1.20:18791', '127.0.0.1:18791', 'localhost:18791', '[::1]:18791'])('accepts %s', async host => {
    expect(await status({ app: app(), headers: { host } })).toBe(200);
  });

  it.each([
    '192.168.1.21:18791',
    '192.168.1.20:9999',
    '192.168.1.20',
    'evil.example:18791',
    'localhost.evil.example:18791',
    '10.0.0.5:18791',
  ])('rejects %s with 421', async host => {
    expect(await status({ app: app(), headers: { host } })).toBe(421);
  });

  it.each(['http://192.168.1.20:18791', 'http://127.0.0.1:18791', 'http://localhost:18791'])(
    'accepts Origin %s on writes',
    async origin => {
      expect(await status({ app: app(), method: 'POST', headers: { host: '127.0.0.1:18791', origin } })).toBe(200);
    },
  );

  it.each(['http://192.168.1.21:18791', 'https://127.0.0.1:18791', 'http://evil.example:18791'])(
    'rejects Origin %s on writes',
    async origin => {
      expect(await status({ app: app(), method: 'POST', headers: { host: '127.0.0.1:18791', origin } })).toBe(403);
    },
  );

  it('does not widen a public address to loopback names on its port', async () => {
    const remote = appFor({ port: 8790, publicBaseUrl: 'http://203.0.113.9:18791' });
    expect(await status({ app: remote, headers: { host: '127.0.0.1:18791' } })).toBe(421);
  });
});
