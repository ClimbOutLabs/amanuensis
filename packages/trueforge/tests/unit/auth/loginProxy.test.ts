import { Hono } from 'hono';
import { createLoginProxy, isProxiableIssuer } from '../../../src/auth/loginProxy';
import { LoginAttemptLimiter } from '../../../src/auth/loginRateLimit';

const ISSUER = 'http://127.0.0.1:5556/dex';
const ORIGINS = ['http://192.168.1.20:8791', 'http://host.example.local:8791', 'http://127.0.0.1:8791'];

interface UpstreamCall {
  url: string;
  method: string;
  redirect: RequestInit['redirect'];
  headers: Headers;
  body: string | undefined;
}

/** What the sign-in service shows again after a wrong password; the real service answers 401. */
const PASSWORD_FORM = '<form method="post"><input name="login"><input type="password" name="password"></form>';
const wrongPassword = () => new Response(PASSWORD_FORM, { status: 401, headers: { 'content-type': 'text/html' } });

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
    const res = await get('/dex/auth/local', {}, 'host.example.local:8791');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://host.example.local:8791/dex/auth/local/login?req=abc');
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
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
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

    beforeEach(() => {
      answer = wrongPassword;
    });

    it('locks an address out after repeated failures, with a wait that grows, and tells it how long', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login()).status).toBe(401);
      }
      const locked = await login();
      expect(locked.status).toBe(429);
      expect(locked.headers.get('retry-after')).toBe('30');
      expect(await locked.text()).toContain('Wait 30 seconds');
      expect(calls).toHaveLength(5);
      clock += 31_000;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login()).status).toBe(401);
      }
      const longer = await login();
      expect(longer.status).toBe(429);
      expect(longer.headers.get('retry-after')).toBe('60');
    });

    it.each([200, 401])('counts a wrong password the service answers with status %i', async status => {
      answer = () => new Response(PASSWORD_FORM, { status, headers: { 'content-type': 'text/html' } });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login()).status).toBe(status);
      }
      expect((await login()).status).toBe(429);
    });

    it('does not count a 400 answer, even one that carries the form', async () => {
      answer = () => new Response(PASSWORD_FORM, { status: 400, headers: { 'content-type': 'text/html' } });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await login()).status).toBe(400);
      }
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
      expect((await get('/dex/auth/local/login?back=&state=s')).status).toBe(401);
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
            resolve(wrongPassword());
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

    it('counts guesses at one account across a sign-in to another, from the same address', async () => {
      const post = (account: string) =>
        get('/dex/auth/local/login?back=&state=s', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `login=${account}&password=guess`,
        });
      answer = wrongPassword;
      for (let round = 0; round < 3; round += 1) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          expect((await post('owner%40example.com')).status).toBe(401);
        }
        answer = () => new Response(null, { status: 303, headers: { location: '/dex/approval?req=a' } });
        expect((await post('member%40example.com')).status).toBe(303);
        answer = wrongPassword;
        await post('owner%40example.com');
        expect((await post('owner%40example.com')).status).toBe(429);
        clock += 31 * 60_000;
      }
    });

    it('tells unknown addresses in plain words how long to wait once an account has had too many wrong passwords', async () => {
      const hono = new Hono();
      hono.all(
        '*',
        createLoginProxy({
          issuerUrl: ISSUER,
          allowedOrigins: ORIGINS,
          limiter,
          clientKey: c => c.req.header('x-test-client') ?? 'unknown',
        }),
      );
      const post = (address: string) =>
        hono.request('http://192.168.1.20:8791/dex/auth/local/login?back=&state=s', {
          method: 'POST',
          headers: {
            host: '192.168.1.20:8791',
            'x-test-client': address,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'login=owner%40example.com&password=guess',
        });
      for (let i = 0; i < 10; i += 1) {
        expect((await post(`198.51.100.${String(i)}`)).status).toBe(401);
      }
      const locked = await post('198.51.100.200');
      expect(locked.status).toBe(429);
      expect(await locked.text()).toBe('Too many wrong passwords. Try again in 5 minutes.');
      expect(locked.headers.get('retry-after')).toBe('300');
      expect(calls).toHaveLength(10);
    });

    it('does not count a post the service refused for a bad request, such as an unknown sign-in state', async () => {
      answer = () => new Response('Bad request', { status: 400, headers: { 'content-type': 'text/html' } });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        expect((await login()).status).toBe(400);
      }
      answer = wrongPassword;
      expect((await login()).status).toBe(401);
    });

    it('does not let junk posts from many addresses lock out a person who is signing in', async () => {
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
      answer = () => new Response('Bad request', { status: 400 });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await many.request('http://192.168.1.20:8791/dex/auth/local/login?state=junk', {
          method: 'POST',
          headers: { host: '192.168.1.20:8791', 'content-type': 'application/x-www-form-urlencoded' },
          body: 'login=a%40b.c&password=x',
        });
      }
      answer = () => new Response(null, { status: 303, headers: { location: '/dex/approval?req=a' } });
      const res = await many.request('http://192.168.1.20:8791/dex/auth/local/login', {
        method: 'POST',
        headers: { host: '192.168.1.20:8791', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'login=a%40b.c&password=right',
      });
      expect(res.status).toBe(303);
    });

    it('keeps the owner signing in through a shared gateway address while strangers fail together', async () => {
      const gatewayLimiter = new LoginAttemptLimiter({ now: () => clock, maxGlobalFailures: 6 });
      const hono = new Hono();
      hono.all(
        '*',
        createLoginProxy({
          issuerUrl: ISSUER,
          allowedOrigins: ORIGINS,
          limiter: gatewayLimiter,
          clientKey: c => c.req.header('x-test-client') ?? 'gateway',
        }),
      );
      const post = (client: string) =>
        hono.request('http://192.168.1.20:8791/dex/auth/local/login', {
          method: 'POST',
          headers: {
            host: '192.168.1.20:8791',
            'x-test-client': client,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'login=a%40b.c&password=x',
        });
      answer = () => new Response(null, { status: 303, headers: { location: '/dex/approval?req=a' } });
      expect((await post('gateway')).status).toBe(303);
      answer = wrongPassword;
      for (let i = 0; i < 6; i += 1) {
        await post(`stranger-${String(i)}`);
      }
      expect((await post('stranger-new')).status).toBe(429);
      answer = () => new Response(null, { status: 303, headers: { location: '/dex/approval?req=a' } });
      expect((await post('gateway')).status).toBe(303);
    });

    it('limits how often one address can start a sign-in, which stores a request in the sign-in service', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        expect((await get('/dex/auth?client_id=x&state=s')).status).toBe(401);
      }
      const res = await get('/dex/auth?client_id=x&state=s');
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('60');
      expect((await get('/dex/static/main.css')).status).toBe(401);
      clock += 60_000;
      expect((await get('/dex/auth/local?client_id=x')).status).toBe(401);
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
          body: 'login=a%40b.c&password=x',
        });
      }
      const res = await many.request('http://192.168.1.20:8791/dex/auth/local/login', {
        method: 'POST',
        headers: { host: '192.168.1.20:8791', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'login=a%40b.c&password=x',
      });
      expect(res.status).toBe(429);
    });
  });
});

/** What the sign-in service reads for a field, the way Go's FormValue does: the body first, then the query, first value. */
function goFormValue({ search, body, name }: { search: string; body: string; name: string }): string | undefined {
  const parse = (text: string): [string, string][] => {
    const pairs: [string, string][] = [];
    for (const part of text.split('&')) {
      if (part === '' || part.includes(';')) {
        continue;
      }
      const [rawKey = '', rawValue = ''] = part.split(/=(.*)/s);
      try {
        pairs.push([
          decodeURIComponent(rawKey.replaceAll('+', ' ')),
          decodeURIComponent(rawValue.replaceAll('+', ' ')),
        ]);
      } catch {
        // Go skips a pair whose escape is broken.
      }
    }
    return pairs;
  };
  const all = [...parse(body), ...parse(search.replace(/^\?/, ''))];
  return all.find(([key]) => key === name)?.[1];
}

describe('the account the limiter counts is the account the sign-in service reads', () => {
  const realFetch = globalThis.fetch;
  let seen: string[];
  let sent: { search: string; body: string }[];

  beforeEach(() => {
    seen = [];
    sent = [];
    globalThis.fetch = (input, init) => {
      const body = init?.body;
      sent.push({
        search: new URL(String(input)).search,
        body: body instanceof ArrayBuffer ? new TextDecoder().decode(body) : '',
      });
      return Promise.resolve(new Response('form', { status: 200 }));
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  class Recording extends LoginAttemptLimiter {
    override begin(key: string, account = '') {
      seen.push(account);
      return super.begin(key, account);
    }
  }

  async function post({
    query = '',
    body,
    type = 'application/x-www-form-urlencoded',
  }: {
    query?: string;
    body: string;
    type?: string;
  }) {
    const hono = new Hono();
    hono.all(
      '*',
      createLoginProxy({ issuerUrl: ISSUER, allowedOrigins: ORIGINS, limiter: new Recording(), clientKey: () => 'a' }),
    );
    return hono.request(`http://192.168.1.20:8791/dex/auth/local/login${query}`, {
      method: 'POST',
      headers: { host: '192.168.1.20:8791', 'content-type': type },
      body,
    });
  }

  it('passes on a plain form, and counts the account the service will read', async () => {
    const res = await post({ query: '?back=&state=s', body: 'login=Owner%40example.com&password=x' });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['Owner@example.com']);
  });

  it.each([
    [
      'a login in the query string, where the service reads it after the body',
      '?login=owner%40example.com',
      'password=x',
    ],
    ['a password in the query string', '?password=x', 'login=member%40example.com&password=y'],
    ['the login given twice in the body', '', 'login=member%40example.com&login=owner%40example.com&password=x'],
    ['the password given twice', '', 'login=member%40example.com&password=x&password=y'],
    ['no login at all', '', 'password=x'],
    ['a broken escape the two readers could split differently', '', 'login=owner%4&password=x'],
    [
      'a semicolon the two readers could split differently',
      '',
      'login=member%40example.com;login=owner%40example.com&password=x',
    ],
    ['a semicolon in the query string', '?x=1;login=owner', 'login=member%40example.com&password=x'],
    ['a key written with escapes', '?lo%67in=owner%40example.com', 'login=member%40example.com&password=x'],
  ])('refuses %s', async (_label, query, body) => {
    const res = await post({ query, body });
    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
    expect(seen).toEqual([]);
  });

  it.each(['multipart/form-data; boundary=x', 'application/json', 'text/plain'])(
    'refuses a form sent as %s',
    async type => {
      const res = await post({ body: 'login=member%40example.com&password=x', type });
      expect(res.status).toBe(415);
      expect(sent).toEqual([]);
    },
  );

  it('refuses a form with no content type', async () => {
    const hono = new Hono();
    hono.all('*', createLoginProxy({ issuerUrl: ISSUER, allowedOrigins: ORIGINS }));
    const res = await hono.request('http://192.168.1.20:8791/dex/auth/local/login', {
      method: 'POST',
      headers: { host: '192.168.1.20:8791' },
      body: 'login=a&password=b',
    });
    expect(res.status).toBe(415);
  });

  it('counts, for every form it passes on, exactly what the service reads, and refuses the rest', async () => {
    const queries = [
      '',
      '?back=&state=s',
      '?back=%2Fdex&state=a+b',
      '?login=x',
      '?x=1&login=y',
      '?Login=owner',
      '?login%5B%5D=owner',
    ];
    const bodies = [
      'login=a%40b.c&password=x',
      'login=a+b&password=x',
      'password=x&login=a%40b.c',
      'login=%C3%A9&password=x',
      'login=&password=x',
      'login=a&login=b&password=x',
      'login=a;login=b&password=x',
      'Login=a&login=b&password=x',
      'login%5B%5D=a&login=b&password=x',
      'login=a%2&password=x',
    ];
    let passed = 0;
    for (const query of queries) {
      for (const body of bodies) {
        seen = [];
        sent = [];
        const res = await post({ query, body });
        if (res.status === 200) {
          passed += 1;
          const reached = sent[0];
          expect(reached).toBeDefined();
          expect(seen).toEqual([
            goFormValue({ search: reached?.search ?? '', body: reached?.body ?? '', name: 'login' }) ?? '',
          ]);
        } else {
          expect([400, 415]).toContain(res.status);
          expect(sent).toEqual([]);
        }
      }
    }
    expect(passed).toBeGreaterThan(8);
  });
});

describe('login proxy in front of a public sign-in address', () => {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];

  beforeEach(() => {
    seen.length = 0;
    globalThis.fetch = input => {
      seen.push(String(input));
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://login.example.com/dex/approval?req=1' } }),
      );
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function gateway({ clientKey, limiter }: { clientKey?: () => string; limiter?: LoginAttemptLimiter } = {}): Hono {
    const hono = new Hono();
    hono.all(
      '*',
      createLoginProxy({
        issuerUrl: 'https://login.example.com/dex',
        upstreamUrl: 'http://127.0.0.1:5556/dex',
        allowedOrigins: ['https://login.example.com'],
        ...(clientKey === undefined ? {} : { clientKey }),
        ...(limiter === undefined ? {} : { limiter }),
      }),
    );
    return hono;
  }

  it('reaches the sign-in service on this computer and keeps the browser on the public address', async () => {
    const res = await gateway().request('https://login.example.com/dex/auth/local/login', {
      method: 'POST',
      headers: { host: 'login.example.com', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'login=a%40b.c&password=x',
    });
    expect(seen).toEqual(['http://127.0.0.1:5556/dex/auth/local/login']);
    expect(res.headers.get('location')).toBe('https://login.example.com/dex/approval?req=1');
  });

  it('limits each visitor behind a reverse proxy on this computer by the address it recorded, and ignores that header elsewhere', async () => {
    globalThis.fetch = () => Promise.resolve(wrongPassword());
    // Checks the per-address limit only, so the account's shared budget is set out of reach.
    const app = gateway({ limiter: new LoginAttemptLimiter({ maxFailuresPerAccount: 1000 }) });
    const post = (remoteAddress: string, forwardedFor: string) =>
      app.fetch(
        new Request('https://login.example.com/dex/auth/local/login', {
          method: 'POST',
          headers: {
            host: 'login.example.com',
            'x-forwarded-for': forwardedFor,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: `login=user-${forwardedFor}&password=x`,
        }),
        { incoming: { socket: { remoteAddress } } },
      );
    for (let i = 0; i < 5; i += 1) {
      expect((await post('127.0.0.1', '203.0.113.5')).status).toBe(401);
    }
    expect((await post('127.0.0.1', '203.0.113.5')).status).toBe(429);
    expect((await post('127.0.0.1', '198.51.100.7')).status).toBe(401);
    for (let i = 0; i < 5; i += 1) {
      expect((await post('192.168.1.40', `10.0.0.${String(i)}`)).status).toBe(401);
    }
    expect((await post('192.168.1.40', '10.9.9.9')).status).toBe(429);
  });

  it('believes X-Forwarded-For from a configured proxy address, and from no other address', async () => {
    globalThis.fetch = () => Promise.resolve(wrongPassword());
    const hono = new Hono();
    hono.all(
      '*',
      createLoginProxy({
        issuerUrl: 'https://login.example.com/dex',
        upstreamUrl: 'http://127.0.0.1:5556/dex',
        allowedOrigins: ['https://login.example.com'],
        trustedProxies: ['172.17.0.1'],
        limiter: new LoginAttemptLimiter({ maxFailuresPerAccount: 1000 }),
      }),
    );
    const post = (remoteAddress: string, forwardedFor: string) =>
      hono.fetch(
        new Request('https://login.example.com/dex/auth/local/login', {
          method: 'POST',
          headers: {
            host: 'login.example.com',
            'x-forwarded-for': forwardedFor,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: `login=user-${forwardedFor}&password=x`,
        }),
        { incoming: { socket: { remoteAddress } } },
      );
    for (let i = 0; i < 5; i += 1) {
      expect((await post('172.17.0.1', '203.0.113.5')).status).toBe(401);
    }
    expect((await post('172.17.0.1', '203.0.113.5')).status).toBe(429);
    expect((await post('::ffff:172.17.0.1', '198.51.100.7')).status).toBe(401);
    for (let i = 0; i < 5; i += 1) {
      expect((await post('172.18.0.9', `10.0.0.${String(i)}`)).status).toBe(401);
    }
    expect((await post('172.18.0.9', '10.9.9.9')).status).toBe(429);
  });

  it('limits IPv6 visitors by their /64, so a changing address does not start the guessing over', async () => {
    globalThis.fetch = () => Promise.resolve(wrongPassword());
    const app = gateway();
    const post = (remoteAddress: string) =>
      app.fetch(
        new Request('https://login.example.com/dex/auth/local/login', {
          method: 'POST',
          headers: { host: 'login.example.com', 'content-type': 'application/x-www-form-urlencoded' },
          body: 'login=a%40b.c&password=x',
        }),
        { incoming: { socket: { remoteAddress } } },
      );
    for (let i = 0; i < 5; i += 1) {
      expect((await post(`2001:db8:1:2:${String(i)}::${String(i + 1)}`)).status).toBe(401);
    }
    expect((await post('2001:db8:1:2:ffff:aaaa:bbbb:cccc')).status).toBe(429);
    expect((await post('2001:db8:1:3::1')).status).toBe(401);
  });

  it('needs the service to have the same path in both places', () => {
    expect(() =>
      createLoginProxy({
        issuerUrl: 'https://login.example.com/other',
        upstreamUrl: 'http://127.0.0.1:5556/dex',
        allowedOrigins: [],
      }),
    ).toThrow(/same path/);
  });

  it('refuses an upstream that is not on this computer', () => {
    expect(() =>
      createLoginProxy({
        issuerUrl: 'https://login.example.com/dex',
        upstreamUrl: 'http://10.0.0.5:5556/dex',
        allowedOrigins: [],
      }),
    ).toThrow(/loopback/);
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
