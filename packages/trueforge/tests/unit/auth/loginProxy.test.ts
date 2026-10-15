import { Hono } from 'hono';
import { createLoginProxy } from '../../../src/auth/loginProxy';

const ISSUER = 'http://127.0.0.1:5556/dex';

describe('login proxy', () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; method: string; headers: Headers; body: string | undefined }[];
  let answer: () => Response;

  beforeEach(() => {
    calls = [];
    answer = () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    globalThis.fetch = (input, init) => {
      const body = init?.body;
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: body instanceof ArrayBuffer ? new TextDecoder().decode(body) : undefined,
      });
      return Promise.resolve(answer());
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function app(): Hono {
    const hono = new Hono();
    hono.all('/dex/*', createLoginProxy({ issuerUrl: ISSUER }));
    return hono;
  }

  it('passes the sign-in pages through to the service and returns its page', async () => {
    const res = await app().request('http://192.168.1.20:8791/dex/auth?client_id=c&state=s');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>login</html>');
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(calls.map(call => call.url)).toEqual(['http://127.0.0.1:5556/dex/auth?client_id=c&state=s']);
  });

  it('passes a form post with its body, and nothing the app knows about the person', async () => {
    const res = await app().request('http://192.168.1.20:8791/dex/auth/local/login?back=&state=s', {
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

  it('keeps a redirect on the address the browser came to and sets no cookie on the app', async () => {
    answer = () =>
      new Response(null, {
        status: 303,
        headers: { location: 'http://127.0.0.1:5556/dex/auth/local/login?req=abc', 'set-cookie': 'x=1' },
      });
    const res = await app().request('http://spark.local:8791/dex/auth/local', { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://spark.local:8791/dex/auth/local/login?req=abc');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('leaves a path-only redirect and the sign-in return address alone', async () => {
    answer = () => new Response(null, { status: 302, headers: { location: '/dex/auth/local/login?req=abc' } });
    const path = await app().request('http://spark.local:8791/dex/auth', { redirect: 'manual' });
    expect(path.headers.get('location')).toBe('/dex/auth/local/login?req=abc');
    answer = () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://192.168.1.20:8791/api/v1/auth/callback?code=c' },
      });
    const back = await app().request('http://192.168.1.20:8791/dex/approval', { redirect: 'manual' });
    expect(back.headers.get('location')).toBe('http://192.168.1.20:8791/api/v1/auth/callback?code=c');
  });

  it.each(['/dex/../admin', '/dex/%2e%2e/admin', '/dex/..%2fadmin'])(
    'never reaches outside the sign-in path (%s)',
    async path => {
      const res = await app().request(`http://192.168.1.20:8791${path}`);
      expect(res.status).toBe(404);
      expect(calls).toEqual([]);
    },
  );

  it('never leaves the issuer origin, whatever the request URL says', async () => {
    const res = await app().request('http://192.168.1.20:8791//evil.example/dex/x');
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('allows only reads and form posts', async () => {
    expect((await app().request('http://192.168.1.20:8791/dex/auth', { method: 'DELETE' })).status).toBe(405);
    expect((await app().request('http://192.168.1.20:8791/dex/auth', { method: 'PUT' })).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it('answers a plain 502 when the service does not answer', async () => {
    globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const res = await app().request('http://192.168.1.20:8791/dex/auth');
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('The sign-in service did not answer.');
  });
});
