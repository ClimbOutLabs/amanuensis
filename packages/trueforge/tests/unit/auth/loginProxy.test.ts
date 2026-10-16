import { Hono } from 'hono';
import { createLoginProxy, isProxiableIssuer } from '../../../src/auth/loginProxy';
import { LoginAttemptLimiter } from '../../../src/auth/loginRateLimit';

const ISSUER = 'http://127.0.0.1:5556/dex';
const ORIGINS = ['http://192.168.1.20:8791', 'http://spark.local:8791', 'http://127.0.0.1:8791'];

interface UpstreamCall {
  url: string;
  method: string;
  redirect: RequestInit['redirect'];
  headers: Headers;
  body: string | undefined;
}

describe('login proxy', () => {
  const realFetch = globalThis.fetch;
  let calls: UpstreamCall[];
  let answer: () => Response;
  let limiter: LoginAttemptLimiter;
  let clock: number;

  beforeEach(() => {
    calls = [];
    clock = 1_000_000;
    limiter = new LoginAttemptLimiter({ now: () => clock });
    answer = () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    globalThis.fetch = (input, init) => {
      const body = init?.body;
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        redirect: init?.redirect,
        headers: new Headers(init?.headers),
        body: body instanceof ArrayBuffer ? new TextDecoder().decode(body) : undefined,
      });
      return Promise.resolve(answer());
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Mounted at `*`, so the proxy itself, not the router, decides which paths it serves. */
  function app(): Hono {
    const hono = new Hono();
    hono.all(
      '*',
      createLoginProxy({ issuerUrl: ISSUER, allowedOrigins: ORIGINS, limiter, clientKey: () => '192.168.1.50' }),
    );
    return hono;
  }

  /** The test client sends no Host header; a browser always does. */
  function get(path: string, init: RequestInit = {}, host = '192.168.1.20:8791'): Response | Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('host')) {
      headers.set('host', host);
    }
    return app().request(`http://${host}${path}`, { redirect: 'manual', ...init, headers });
  }

  it('passes the browser pages through to the service and returns its page, never following a redirect itself', async () => {
    const res = await get('/dex/auth?client_id=c&state=s');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>login</html>');
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(calls.map(call => call.url)).toEqual(['http://127.0.0.1:5556/dex/auth?client_id=c&state=s']);
    expect(calls.every(call => call.redirect === 'manual')).toBe(true);
  });

  it.each(['/dex/auth', '/dex/auth/local', '/dex/auth/local/login', '/dex/approval', '/dex/callback'])(
    'serves the browser path %s',
    async path => {
      expect((await get(path)).status).toBe(200);
      expect(calls).toHaveLength(1);
    },
  );

  it.each(['/dex/static/main.css', '/dex/theme/styles.css'])('serves the asset %s', async path => {
    expect((await get(path)).status).toBe(200);
  });

  it.each([
    '/dex/token',
    '/dex/userinfo',
    '/dex/keys',
    '/dex/device',
    '/dex/device/code',
    '/dex/device/token',
    '/dex/.well-known/openid-configuration',
    '/dex/healthz',
    '/dex/introspect',
    '/dex/',
    '/dex',
    '/dex/authx',
    '/admin',
    '/api/v1/sessions',
  ])('never reaches the service endpoint %s', async path => {
    expect((await get(path)).status).toBe(404);
    expect((await get(path, { method: 'POST', body: 'a=b' })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('passes a form post with its body, and nothing the app knows about the person', async () => {
    const res = await get('/dex/auth/local/login?back=&state=s', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'id_token=SECRET-SESSION',
        authorization: 'Bearer SECRET-TOKEN',
        'x-forwarded-for': '1.2.3.4',
      },
      body: 'login=a%40b.c&password=pw',
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('login=a%40b.c&password=pw');
    expect(calls[0]?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(calls[0]?.headers.get('cookie')).toBeNull();
    expect(calls[0]?.headers.get('authorization')).toBeNull();
    expect(calls[0]?.headers.get('x-forwarded-for')).toBeNull();
  });

  it('keeps a redirect on the listed address the request came to and sets no cookie on the app', async () => {
    answer = () =>
      new Response(null, {
        status: 303,
        headers: { location: 'http://127.0.0.1:5556/dex/auth/local/login?req=abc', 'set-cookie': 'x=1' },
      });
    const res = await get('/dex/auth/local', {}, 'spark.local:8791');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://spark.local:8791/dex/auth/local/login?req=abc');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('builds the redirect from the listed address, never from an absolute-form request target', async () => {
    answer = () =>
      new Response(null, { status: 303, headers: { location: 'http://127.0.0.1:5556/dex/auth/local/login?req=a' } });
    const hono = app();
    const res = await hono.request('http://evil.example/dex/auth/local', {
      redirect: 'manual',
      headers: { host: '192.168.1.20:8791' },
    });
    expect(res.headers.get('location')).toBe('http://192.168.1.20:8791/dex/auth/local/login?req=a');
  });

  it('leaves a path-only redirect and the sign-in return address alone', async () => {
    answer = () => new Response(null, { status: 302, headers: { location: '/dex/auth/local/login?req=abc' } });
    const path = await get('/dex/auth');
    expect(path.headers.get('location')).toBe('/dex/auth/local/login?req=abc');
    answer = () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://192.168.1.20:8791/api/v1/auth/callback?code=c' },
      });
    const back = await get('/dex/approval');
    expect(back.headers.get('location')).toBe('http://192.168.1.20:8791/api/v1/auth/callback?code=c');
  });

  it('refuses an address that is not listed, with the plain words to fix it, before anything is sent on', async () => {
    const res = await get('/dex/auth', {}, '192.168.1.99:8791');
    expect(res.status).toBe(421);
    expect(await res.text()).toContain('aman doctor network --fix');
    expect(calls).toEqual([]);
  });

  it('puts security headers on every page it passes through', async () => {
    const res = await get('/dex/auth');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('forbids caching and referrers even when the sign-in service allows them', async () => {
    answer = () => new Response('x', { headers: { 'cache-control': 'public, max-age=3600' } });
    expect((await get('/dex/static/main.css')).headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    '/dex/../admin',
    '/dex/%2e%2e/admin',
    '/dex/..%2fadmin',
    '/dex/..%2Fadmin',
    '/dex/auth%5c..%5cadmin',
    '/dex/auth%2Fx',
  ])('never reaches outside the sign-in path (%s)', async path => {
    expect((await get(path)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('never leaves the issuer origin, whatever the request URL says', async () => {
    expect((await get('//evil.example/dex/auth')).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('answers HEAD without a body, and refuses OPTIONS and writes', async () => {
    const head = await get('/dex/auth', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(calls[0]?.method).toBe('HEAD');
    for (const method of ['OPTIONS', 'DELETE', 'PUT', 'PATCH']) {
      expect((await get('/dex/auth', { method })).status).toBe(405);
    }
    expect(calls).toHaveLength(1);
  });

  it('answers a plain 502 when the service does not answer', async () => {
    globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const res = await get('/dex/auth');
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('The sign-in service did not answer.');
  });

  describe('password guessing', () => {
    const login = () =>
      get('/dex/auth/local/login?back=&state=s', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'login=a%40b.c&password=wrong',
      });

    it('locks an address out after repeated failures, with a wait that grows, and tells it how long', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login()).status).toBe(200);
      }
      const locked = await login();
      expect(locked.status).toBe(429);
      expect(locked.headers.get('retry-after')).toBe('30');
      expect(await locked.text()).toContain('Wait 30 seconds');
      expect(calls).toHaveLength(5);
      clock += 31_000;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login()).status).toBe(200);
      }
      const longer = await login();
      expect(longer.status).toBe(429);
      expect(longer.headers.get('retry-after')).toBe('60');
    });

    it('does not count a password that was accepted, so a person who signs in often is never locked out', async () => {
      answer = () => new Response(null, { status: 303, headers: { location: '/dex/approval?req=a' } });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        expect((await login()).status).toBe(303);
      }
    });

    it('leaves the pages themselves alone while an address is locked out', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login();
      }
      expect((await login()).status).toBe(429);
      expect((await get('/dex/auth/local/login?back=&state=s')).status).toBe(200);
    });

    it('lets no more password attempts reach the sign-in service than the limit when many arrive at once', async () => {
      globalThis.fetch = (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          redirect: init?.redirect,
          headers: new Headers(init?.headers),
          body: undefined,
        });
        return new Promise(resolve => {
          setTimeout(() => {
            resolve(new Response('<html>login</html>', { status: 200 }));
          }, 20);
        });
      };
      const responses = await Promise.all(Array.from({ length: 60 }, () => login()));
      expect(calls).toHaveLength(5);
      expect(responses.filter(res => res.status === 429)).toHaveLength(55);
    });

    it('does not count a sign-in service that did not answer as a failed password', async () => {
      globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
      for (let attempt = 0; attempt < 12; attempt += 1) {
        expect((await login()).status).toBe(502);
      }
    });

    it('limits how often one address can start a sign-in, which stores a request in the sign-in service', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        expect((await get('/dex/auth?client_id=x&state=s')).status).toBe(200);
      }
      const res = await get('/dex/auth?client_id=x&state=s');
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('60');
      expect((await get('/dex/static/main.css')).status).toBe(200);
      clock += 60_000;
      expect((await get('/dex/auth/local?client_id=x')).status).toBe(200);
    });

    it('makes everyone wait when many addresses fail together', async () => {
      let n = 0;
      const many = new Hono();
      many.all(
        '*',
        createLoginProxy({
          issuerUrl: ISSUER,
          allowedOrigins: ORIGINS,
          limiter,
          clientKey: () => `10.0.0.${String(n++)}`,
        }),
      );
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await many.request('http://192.168.1.20:8791/dex/auth/local/login', {
          method: 'POST',
          headers: { host: '192.168.1.20:8791', 'content-type': 'application/x-www-form-urlencoded' },
          body: 'password=x',
        });
      }
      const res = await many.request('http://192.168.1.20:8791/dex/auth/local/login', {
        method: 'POST',
        headers: { host: '192.168.1.20:8791', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=x',
      });
      expect(res.status).toBe(429);
    });
  });
});

describe('isProxiableIssuer', () => {
  it.each(['http://127.0.0.1:5556/dex', 'http://localhost:5556/dex/', 'http://[::1]:5556/auth'])(
    'accepts %s',
    issuer => {
      expect(isProxiableIssuer(issuer)).toBe(true);
    },
  );

  it.each([
    'http://127.0.0.1:5556',
    'http://127.0.0.1:5556/',
    'https://login.example.com/dex',
    'http://192.168.1.20:5556/dex',
    'http://login.example.com/dex',
    'not a url',
  ])('refuses %s, so the proxy cannot shadow the app or reach elsewhere', issuer => {
    expect(isProxiableIssuer(issuer)).toBe(false);
    expect(() => createLoginProxy({ issuerUrl: issuer, allowedOrigins: ORIGINS })).toThrow();
  });
});
