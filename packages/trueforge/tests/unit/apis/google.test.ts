import { Hono } from 'hono';
import { createLogger } from 'winston';
import { createGoogleRouter } from '../../../src/apis/google';
import type { RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';

const ID = '123456789-abcdefghij.apps.googleusercontent.com';
const SECRET = 'GOCSPX-abcdefghijklmnop';
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const LAN = 'http://192.168.1.20:8791';
const BASE = '/api/v1/user/settings/google';

function user(id: string): RequestContext {
  return { tenant_id: 't1', subject: { id, type: 'user', display_name: id }, roles: [], user_credential: null };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Google connection API', () => {
  let env: SqliteTestDatabase;
  let app: Hono;
  let granted = `${READ}`;
  const calls: string[] = [];
  const originalBase = configuration.PUBLIC_BASE_URL;

  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0] ?? url}`);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(
        body.get('grant_type') === 'authorization_code'
          ? jsonResponse({ access_token: 'at', refresh_token: 'rt-secret', scope: granted })
          : jsonResponse({ access_token: 'at' }),
      );
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile')) {
      return Promise.resolve(jsonResponse({ emailAddress: 'ada@example.com' }));
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
      return Promise.resolve(new Response('', { status: 200 }));
    }
    return Promise.resolve(new Response('', { status: 500 }));
  };

  async function call(input: { method: string; path: string; as?: string; origin?: string; body?: unknown }) {
    const response = await app.request(`${input.origin ?? LAN}${BASE}${input.path}`, {
      method: input.method,
      headers: { 'Content-Type': 'application/json', 'x-test-user': input.as ?? 'ada' },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    return { status: response.status, text: await response.text() };
  }

  async function connect(as = 'ada') {
    const begin = await call({
      method: 'POST',
      path: '/oauth/begin',
      as,
      body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['gmail_read'] },
    });
    const url = new URL((JSON.parse(begin.text) as { data: { authorization_url: string } }).data.authorization_url);
    return call({
      method: 'POST',
      path: '/oauth/complete',
      as,
      body: { address: `http://127.0.0.1:53682/callback?state=${url.searchParams.get('state') ?? ''}&code=abc` },
    });
  }

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    granted = READ;
    calls.length = 0;
    configuration.PUBLIC_BASE_URL = '';
    const router = createGoogleRouter({
      googleConnectionStore: new SqliteGoogleConnectionStore(env.db),
      resolveRequestContext: c => user(c.req.header('x-test-user') ?? 'ada'),
      logger: createLogger({ silent: true }),
      fetchImpl: fakeFetch,
    });
    app = new Hono();
    app.route(BASE, router);
  }, 120_000);

  afterEach(async () => {
    configuration.PUBLIC_BASE_URL = originalBase;
    await env.teardown();
  });

  it('starts not connected and asks a LAN browser for a Desktop client and a pasted address', async () => {
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(200);
    expect(JSON.parse(text).data).toMatchObject({
      state: 'not_connected',
      account_email: null,
      has_saved_client: false,
      setup: { mode: 'paste', client_type: 'desktop', redirect_uri: 'http://127.0.0.1:53682/callback' },
    });
  });

  it('asks for a Web client with the exact public callback when the install has a public https address', async () => {
    configuration.PUBLIC_BASE_URL = 'https://aman.example.org';
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.setup).toEqual({
      mode: 'web',
      client_type: 'web',
      redirect_uri: 'https://aman.example.org/api/v1/user/settings/google/oauth/callback',
    });
  });

  it('connects through the pasted address, names the account, and never returns a secret', async () => {
    const { status, text } = await connect();
    expect(status).toBe(200);
    expect(JSON.parse(text).data).toMatchObject({ state: 'connected', account_email: 'ada@example.com' });
    expect(JSON.parse(text).data.features).toEqual([
      expect.objectContaining({ feature: 'gmail_read', granted: true }),
      expect.objectContaining({ feature: 'gmail_compose', granted: false }),
    ]);
    const statusText = (await call({ method: 'GET', path: '/status' })).text;
    for (const body of [text, statusText]) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain('rt-secret');
    }
  });

  it('keeps each user connection separate', async () => {
    await connect('ada');
    const other = await call({ method: 'GET', path: '/status', as: 'grace' });
    expect(JSON.parse(other.text).data.state).toBe('not_connected');
  });

  it('adds sending later with the saved client, never revoking the first login', async () => {
    await connect();
    granted = `${READ} ${COMPOSE}`;
    const begin = await call({
      method: 'POST',
      path: '/oauth/begin',
      body: { features: ['gmail_compose'] },
    });
    expect(begin.status).toBe(201);
    const url = new URL(JSON.parse(begin.text).data.authorization_url);
    expect(url.searchParams.get('scope')).toBe(`${READ} ${COMPOSE}`);
    const done = await call({
      method: 'POST',
      path: '/oauth/complete',
      body: { address: `http://127.0.0.1:53682/callback?state=${url.searchParams.get('state') ?? ''}&code=abc` },
    });
    expect(JSON.parse(done.text).data.features.every((feature: { granted: boolean }) => feature.granted)).toBe(true);
    expect(calls.some(entry => entry.includes('/revoke'))).toBe(false);
  });

  it('refuses a pasted address whose state is not the one in flight', async () => {
    await call({
      method: 'POST',
      path: '/oauth/begin',
      body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['gmail_read'] },
    });
    const done = await call({
      method: 'POST',
      path: '/oauth/complete',
      body: { address: 'http://127.0.0.1:53682/callback?state=forged&code=abc' },
    });
    expect(done.status).toBe(400);
  });

  it('refuses a bare code with a message about the whole address', async () => {
    const done = await call({ method: 'POST', path: '/oauth/complete', body: { address: 'abc' } });
    expect(done.status).toBe(400);
    expect(done.text).toContain('web address');
  });

  it('refuses a Web client where this install needs a Desktop client', async () => {
    const begin = await call({
      method: 'POST',
      path: '/oauth/begin',
      body: { client: { client_id: ID, client_secret: SECRET, client_type: 'web' }, features: ['gmail_read'] },
    });
    expect(begin.status).toBe(400);
    expect(begin.text).toContain('Desktop app');
  });

  it('finishes through the browser callback on the same machine', async () => {
    const origin = 'http://localhost:8791';
    const begin = await call({
      origin,
      method: 'POST',
      path: '/oauth/begin',
      body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['gmail_read'] },
    });
    const url = new URL(JSON.parse(begin.text).data.authorization_url);
    expect(url.searchParams.get('redirect_uri')).toBe(`${origin}${BASE}/oauth/callback`);
    const response = await app.request(
      `${origin}${BASE}/oauth/callback?code=abc&state=${url.searchParams.get('state') ?? ''}`,
      { headers: { 'x-test-user': 'ada' } },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse((await call({ method: 'GET', path: '/status' })).text).data.state).toBe('connected');
  });

  it('tests the connection and disconnects, revoking at Google first', async () => {
    await connect();
    const test = await call({ method: 'POST', path: '/test' });
    expect(JSON.parse(test.text).data).toEqual({ result: 'ok', account_email: 'ada@example.com' });
    const gone = await call({ method: 'POST', path: '/disconnect' });
    expect(JSON.parse(gone.text).data).toEqual({ disconnected: true });
    expect(calls.filter(entry => entry.includes('/revoke'))).toHaveLength(1);
    expect(JSON.parse((await call({ method: 'GET', path: '/status' })).text).data.state).toBe('not_connected');
  });
});
