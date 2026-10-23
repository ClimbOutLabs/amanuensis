import { GOOGLE_FEATURES, scopesForFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from 'winston';
import { z } from 'zod';
import { createGoogleRouter } from '../../../src/apis/google';
import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const ID = '123456789-abcdefghij.apps.googleusercontent.com';
const SECRET = 'GOCSPX-abcdefghijklmnop';
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const EVERY_SCOPE = scopesForFeatures(GOOGLE_FEATURES).join(' ');
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';
const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events';
const LAN = 'http://192.168.1.20:8791';
const BASE = '/api/v1/user/settings/google';
const BeginResponse = z.object({ data: z.object({ authorization_url: z.string() }) });

function user(id: string): RequestContext {
  return { tenant_id: 't1', subject: { id, type: 'user', display_name: id }, roles: [], user_credential: null };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Identifies the caller by `x-test-user`; a request without it is unauthenticated. */
const headerAuthenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    return Promise.resolve(authedUser(user));
  },
};

function authedUser(id: string): RequestContext {
  return { tenant_id: 'default', subject: { id, type: 'user', display_name: id }, roles: [], user_credential: null };
}

describe('Google connection API', () => {
  let env: SqliteTestDatabase;
  let app: Hono;
  let granted = `${READ}`;
  let revoked = false;
  let revokeStatus = 200;
  let profileEmail = 'ada@example.com';
  const calls: string[] = [];
  const originalBase = configuration.PUBLIC_BASE_URL;

  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0] ?? url}`);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      if (revoked && body.get('grant_type') === 'refresh_token') {
        return Promise.resolve(jsonResponse({ error: 'invalid_grant' }, 400));
      }
      return Promise.resolve(
        body.get('grant_type') === 'authorization_code'
          ? jsonResponse({ access_token: 'at', refresh_token: 'rt-secret', scope: granted })
          : jsonResponse({ access_token: 'at' }),
      );
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile')) {
      return Promise.resolve(jsonResponse({ emailAddress: profileEmail }));
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
      return Promise.resolve(new Response('', { status: revokeStatus }));
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
    const url = new URL(BeginResponse.parse(JSON.parse(begin.text)).data.authorization_url);
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
    revoked = false;
    revokeStatus = 200;
    profileEmail = 'ada@example.com';
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
    const { text } = await call({ method: 'GET', path: '/status', origin: 'https://aman.example.org' });
    expect(JSON.parse(text).data.setup).toEqual({
      mode: 'web',
      client_type: 'web',
      redirect_uri: 'https://aman.example.org/api/v1/user/settings/google/oauth/callback',
    });
  });

  it('treats a proxy that forwards the public host as the public address', async () => {
    configuration.PUBLIC_BASE_URL = 'https://aman.example.org';
    const response = await app.request(`http://aman:8791${BASE}/status`, {
      headers: { 'x-test-user': 'ada', 'x-forwarded-host': 'aman.example.org', 'x-forwarded-proto': 'https' },
    });
    expect(JSON.parse(await response.text()).data.setup.mode).toBe('web');
  });

  it('ignores a forwarded host that is not the public address, and any forwarded host with no public address', async () => {
    configuration.PUBLIC_BASE_URL = 'https://aman.example.org';
    for (const forwarded of ['evil.example.net', 'aman.example.org.evil.example.net', 'aman.example.org:8443']) {
      const response = await app.request(`http://aman:8791${BASE}/status`, {
        headers: { 'x-test-user': 'ada', 'x-forwarded-host': forwarded, 'x-forwarded-proto': 'https' },
      });
      expect(JSON.parse(await response.text()).data.setup.mode).toBe('paste');
    }
    configuration.PUBLIC_BASE_URL = '';
    const none = await app.request(`http://aman:8791${BASE}/status`, {
      headers: { 'x-test-user': 'ada', 'x-forwarded-host': 'aman.example.org', 'x-forwarded-proto': 'https' },
    });
    expect(JSON.parse(await none.text()).data.setup.mode).toBe('paste');
  });

  it('falls back to a pasted address for a browser on the LAN even when a public address is set', async () => {
    configuration.PUBLIC_BASE_URL = 'https://aman.example.org';
    const { text } = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(text).data.setup.mode).toBe('paste');
  });

  it('uses a pasted address when the public address is a Tailscale name', async () => {
    configuration.PUBLIC_BASE_URL = 'https://box.tailnet-name.ts.net';
    const { text } = await call({ method: 'GET', path: '/status', origin: 'https://box.tailnet-name.ts.net' });
    expect(JSON.parse(text).data.setup.mode).toBe('paste');
  });

  describe('on a demo instance', () => {
    let originalMode: boolean;
    let originalAccount: string;
    const statusOf = async (as?: string) =>
      JSON.parse((await call({ method: 'GET', path: '/status', ...(as === undefined ? {} : { as }) })).text).data;
    beforeEach(() => {
      originalMode = configuration.DEMO_MODE;
      originalAccount = configuration.DEMO_GOOGLE_ACCOUNT;
      configuration.DEMO_MODE = true;
      configuration.DEMO_GOOGLE_ACCOUNT = 'ada@example.com';
      granted = EVERY_SCOPE;
    });
    afterEach(() => {
      configuration.DEMO_MODE = originalMode;
      configuration.DEMO_GOOGLE_ACCOUNT = originalAccount;
    });

    it('lets the owner connect the named account before the demo opens', async () => {
      expect(await statusOf()).toMatchObject({ locked: false });
      const { status, text } = await connect();
      expect(status).toBe(200);
      expect(JSON.parse(text).data).toMatchObject({
        state: 'connected',
        account_email: 'ada@example.com',
        locked: true,
      });
    });

    it('locks the connection once made: no reconnecting and no disconnecting', async () => {
      await connect();
      const locked: { method: string; path: string }[] = [
        { method: 'POST', path: '/oauth/check-client' },
        { method: 'POST', path: '/oauth/begin' },
        { method: 'POST', path: '/oauth/complete' },
        { method: 'POST', path: '/disconnect' },
      ];
      for (const { method, path } of locked) {
        const response = await call({ method, path, body: {} });
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
        expect(response.text).toContain("This demo's Google account is already set up and cannot be changed.");
      }
      expect(await statusOf()).toMatchObject({ state: 'connected', locked: true });
    });

    it('never lets a demo visitor disconnect, even when the account is not yet connected', async () => {
      expect((await call({ method: 'POST', path: '/disconnect' })).status).toBe(403);
    });

    it('still lets the connection be tested', async () => {
      await connect();
      expect((await call({ method: 'POST', path: '/test' })).status).toBe(200);
    });

    it('refuses to connect any other Google account, and saves nothing', async () => {
      profileEmail = 'judge@gmail.example';
      const { status, text } = await connect('judge');
      expect(status).toBe(400);
      expect(text).toContain("Only this demo's own Google account can be connected here.");
      expect(await statusOf('judge')).toMatchObject({ state: 'not_connected', account_email: null, locked: false });
    });

    it('lets a different user than the owner connect only the named account', async () => {
      profileEmail = 'Ada@Example.com';
      expect((await connect('judge')).status).toBe(200);
      expect((await statusOf('judge')).account_email).toBe('Ada@Example.com');
    });

    it('refuses every connect step, and says why, until the owner names the demo account', async () => {
      configuration.DEMO_GOOGLE_ACCOUNT = '';
      for (const path of ['/oauth/check-client', '/oauth/begin', '/oauth/complete']) {
        const response = await call({ method: 'POST', path, body: {} });
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
        expect(response.text).toContain("until its owner names the demo's Google account");
      }
      expect(await statusOf()).toMatchObject({ state: 'not_connected', locked: true });
    });

    it('lets the named account repair a login Google stopped accepting, and no one else', async () => {
      await connect();
      revoked = true;
      expect(JSON.parse((await call({ method: 'POST', path: '/test' })).text).data.result).toBe('needs_reconnect');
      expect(await statusOf()).toMatchObject({ state: 'needs_reconnect', locked: false });

      profileEmail = 'judge@gmail.example';
      expect((await connect()).status).toBe(400);
      expect((await statusOf()).state).toBe('needs_reconnect');

      profileEmail = 'ada@example.com';
      revoked = false;
      expect((await connect()).status).toBe(200);
      expect(await statusOf()).toMatchObject({ state: 'connected', locked: true });
    });

    it('asks Google for every feature, whatever the request named', async () => {
      const begin = await call({
        method: 'POST',
        path: '/oauth/begin',
        body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['gmail_read'] },
      });
      expect(begin.status).toBe(201);
      const url = new URL(BeginResponse.parse(JSON.parse(begin.text)).data.authorization_url);
      expect(url.searchParams.get('scope')).toBe(EVERY_SCOPE);
    });

    it('lets the named account come back for a feature it was not given, then locks', async () => {
      granted = READ;
      await connect();
      expect(await statusOf()).toMatchObject({ state: 'connected', account_email: 'ada@example.com', locked: false });
      granted = EVERY_SCOPE;
      expect((await connect()).status).toBe(200);
      const status = await statusOf();
      expect(status).toMatchObject({ state: 'connected', account_email: 'ada@example.com', locked: true });
      expect(status.features.every((feature: { granted: boolean }) => feature.granted)).toBe(true);
    });

    it('still refuses any other account while a feature is missing, and saves nothing', async () => {
      granted = READ;
      await connect();
      const before = await statusOf();
      profileEmail = 'judge@gmail.example';
      granted = EVERY_SCOPE;
      const { status, text } = await connect();
      expect(status).toBe(400);
      expect(text).toContain("Only this demo's own Google account can be connected here.");
      expect(await statusOf()).toEqual(before);
    });

    it('lets the named account replace a saved login that belongs to another account', async () => {
      configuration.DEMO_GOOGLE_ACCOUNT = '';
      configuration.DEMO_MODE = false;
      profileEmail = 'someone@else.example';
      await connect();
      configuration.DEMO_MODE = true;
      configuration.DEMO_GOOGLE_ACCOUNT = 'ada@example.com';
      expect(await statusOf()).toMatchObject({ account_email: 'someone@else.example', locked: false });
      profileEmail = 'ada@example.com';
      expect((await connect()).status).toBe(200);
      expect(await statusOf()).toMatchObject({ account_email: 'ada@example.com', locked: true });
    });
  });

  describe('a request that did not come from the Aman page', () => {
    const post = (path: string, headers: Record<string, string>) =>
      app.request(`${LAN}${BASE}${path}`, { method: 'POST', headers: { 'x-test-user': 'ada', ...headers } });

    it.each(['/test', '/disconnect'])('refuses a cross-site form to %s', async path => {
      await connect();
      const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
      expect((await post(path, { ...form, Origin: 'https://evil.example.net' })).status).toBe(403);
      expect((await post(path, { ...form, Origin: 'null' })).status).toBe(403);
      expect((await post(path, form)).status).toBe(403);
      expect((await post(path, { 'Content-Type': 'text/plain', Origin: 'https://evil.example.net' })).status).toBe(403);
      expect(JSON.parse((await call({ method: 'GET', path: '/status' })).text).data.state).toBe('connected');
    });

    it('answers a JSON call and a same-origin call with no body', async () => {
      await connect();
      expect((await post('/test', { 'Content-Type': 'application/json' })).status).toBe(200);
      expect((await post('/test', { Origin: LAN })).status).toBe(200);
      expect((await post('/disconnect', { Origin: LAN })).status).toBe(200);
    });

    it('trusts the public address as an origin too', async () => {
      configuration.PUBLIC_BASE_URL = 'https://aman.example.org';
      expect((await post('/test', { Origin: 'https://aman.example.org' })).status).toBe(200);
    });
  });

  describe('through the installer TLS proxy, on an install whose public address is loopback', () => {
    const HOME = 'https://192.168.1.20:8443';
    const INTERNAL = 'http://aman:8791';
    let originalOrigins: string[];

    beforeEach(() => {
      originalOrigins = configuration.ALLOWED_ORIGINS;
      configuration.PUBLIC_BASE_URL = 'http://127.0.0.1:8791';
      configuration.ALLOWED_ORIGINS = [HOME];
    });

    afterEach(() => {
      configuration.ALLOWED_ORIGINS = originalOrigins;
    });

    const proxied = (path: string, headers: Record<string, string>) =>
      app.request(`${INTERNAL}${BASE}${path}`, { method: 'POST', headers: { 'x-test-user': 'ada', ...headers } });

    it('disconnects when the browser came through the proxy at the recorded home-network address', async () => {
      await connect();
      const response = await proxied('/disconnect', {
        Origin: HOME,
        'x-forwarded-host': '192.168.1.20:8443',
        'x-forwarded-proto': 'https',
      });
      expect(response.status).toBe(200);
      expect(JSON.parse((await call({ method: 'GET', path: '/status' })).text).data.state).toBe('not_connected');
    });

    it('answers a bodiless call whose Origin is a recorded address, with no proxy headers', async () => {
      await connect();
      expect((await proxied('/test', { Origin: HOME })).status).toBe(200);
    });

    it('still refuses an address the installer does not serve this instance on', async () => {
      await connect();
      const byOrigin = await proxied('/disconnect', {
        Origin: 'https://192.168.1.99:8443',
        'x-forwarded-host': '192.168.1.99:8443',
        'x-forwarded-proto': 'https',
      });
      expect(byOrigin.status).toBe(403);
      expect(JSON.parse(await byOrigin.text()).error.message).toBe(
        'That request did not come from Aman, so nothing was done.',
      );
      const form = await proxied('/disconnect', {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://evil.example.net',
        'x-forwarded-host': '192.168.1.20:8443',
        'x-forwarded-proto': 'https',
      });
      expect(form.status).toBe(403);
      expect(JSON.parse((await call({ method: 'GET', path: '/status' })).text).data.state).toBe('connected');
    });
  });

  it('asks for read access when sending alone is requested', async () => {
    const begin = await call({
      method: 'POST',
      path: '/oauth/begin',
      body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['gmail_compose'] },
    });
    expect(begin.status).toBe(400);
    expect(JSON.parse(begin.text).error).toMatchObject({ type: 'invalid_features' });
    expect(JSON.parse(begin.text).error.message).toContain('Sending needs permission to read mail too');
  });

  it('does not spend the attempt in progress on a pasted page that is not the return address', async () => {
    const begin = await call({
      method: 'POST',
      path: '/oauth/begin',
      body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['gmail_read'] },
    });
    const state = new URL(JSON.parse(begin.text).data.authorization_url).searchParams.get('state') ?? '';
    const wrong = await call({
      method: 'POST',
      path: '/oauth/complete',
      body: { address: `https://example.com/callback?state=${state}&code=abc` },
    });
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.text).error.message).toContain('not the page Google sent you to');
    const real = await call({
      method: 'POST',
      path: '/oauth/complete',
      body: { address: `http://127.0.0.1:53682/callback?state=${state}&code=abc` },
    });
    expect(real.status).toBe(200);
  });

  it('removes the connection even when Google does not confirm the revocation', async () => {
    await connect();
    revokeStatus = 503;
    const gone = await call({ method: 'POST', path: '/disconnect' });
    expect(gone.status).toBe(200);
    expect(JSON.parse(gone.text).data).toEqual({ revocation_confirmed: false });
    expect(JSON.parse((await call({ method: 'GET', path: '/status' })).text).data.state).toBe('not_connected');
  });

  it('connects through the pasted address, names the account, and never returns a secret', async () => {
    const { status, text } = await connect();
    expect(status).toBe(200);
    expect(JSON.parse(text).data).toMatchObject({ state: 'connected', account_email: 'ada@example.com' });
    expect(JSON.parse(text).data.features).toEqual([
      expect.objectContaining({ feature: 'gmail_read', granted: true }),
      expect.objectContaining({ feature: 'gmail_compose', granted: false }),
      expect.objectContaining({ feature: 'calendar_read', granted: false }),
      expect.objectContaining({ feature: 'calendar_write', granted: false }),
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
    expect(JSON.parse(done.text).data.features).toEqual([
      expect.objectContaining({ feature: 'gmail_read', granted: true }),
      expect.objectContaining({ feature: 'gmail_compose', granted: true }),
      expect.objectContaining({ feature: 'calendar_read', granted: false }),
      expect.objectContaining({ feature: 'calendar_write', granted: false }),
    ]);
    expect(calls.some(entry => entry.includes('/revoke'))).toBe(false);
  });

  it('adds Calendar later as a second consent on the saved client, keeping mail and never revoking', async () => {
    await connect();
    granted = `${READ} ${CALENDAR}`;
    const begin = await call({ method: 'POST', path: '/oauth/begin', body: { features: ['calendar_read'] } });
    expect(begin.status).toBe(201);
    const url = new URL(JSON.parse(begin.text).data.authorization_url);
    expect(url.searchParams.get('scope')).toBe(`${READ} ${CALENDAR}`);
    const done = await call({
      method: 'POST',
      path: '/oauth/complete',
      body: { address: `http://127.0.0.1:53682/callback?state=${url.searchParams.get('state') ?? ''}&code=abc` },
    });
    expect(JSON.parse(done.text).data.features).toEqual([
      expect.objectContaining({ feature: 'gmail_read', granted: true }),
      expect.objectContaining({ feature: 'gmail_compose', granted: false }),
      expect.objectContaining({ feature: 'calendar_read', granted: true }),
      expect.objectContaining({ feature: 'calendar_write', granted: false }),
    ]);
    expect(calls.some(entry => entry.includes('/revoke'))).toBe(false);
  });

  it('lets a Calendar user allow adding events as one more consent, keeping every scope they had', async () => {
    await connect();
    granted = `${READ} ${CALENDAR}`;
    const first = await call({ method: 'POST', path: '/oauth/begin', body: { features: ['calendar_read'] } });
    const firstUrl = new URL(JSON.parse(first.text).data.authorization_url);
    await call({
      method: 'POST',
      path: '/oauth/complete',
      body: { address: `http://127.0.0.1:53682/callback?state=${firstUrl.searchParams.get('state') ?? ''}&code=abc` },
    });
    granted = `${READ} ${CALENDAR} ${CALENDAR_WRITE}`;
    const begin = await call({
      method: 'POST',
      path: '/oauth/begin',
      body: { features: ['calendar_read', 'calendar_write'] },
    });
    expect(begin.status).toBe(201);
    const url = new URL(JSON.parse(begin.text).data.authorization_url);
    expect(url.searchParams.get('scope')).toBe(`${READ} ${CALENDAR} ${CALENDAR_WRITE}`);
    const done = await call({
      method: 'POST',
      path: '/oauth/complete',
      body: { address: `http://127.0.0.1:53682/callback?state=${url.searchParams.get('state') ?? ''}&code=abc` },
    });
    expect(JSON.parse(done.text).data.features).toEqual([
      expect.objectContaining({ feature: 'gmail_read', granted: true }),
      expect.objectContaining({ feature: 'gmail_compose', granted: false }),
      expect.objectContaining({ feature: 'calendar_read', granted: true }),
      expect.objectContaining({ feature: 'calendar_write', granted: true, label: 'Add and change events you approve' }),
    ]);
    expect(calls.some(entry => entry.includes('/revoke'))).toBe(false);
  });

  it('asks Calendar-only callers to connect mail first, in plain words', async () => {
    const begin = await call({
      method: 'POST',
      path: '/oauth/begin',
      body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['calendar_read'] },
    });
    expect(begin.status).toBe(400);
    expect(JSON.parse(begin.text).error).toMatchObject({ type: 'invalid_features' });
    expect(JSON.parse(begin.text).error.message).toContain('Connect Google first, then add Calendar');
  });

  it('refuses a pasted address whose state is not the one in flight, and the real attempt still finishes', async () => {
    const begin = await call({
      method: 'POST',
      path: '/oauth/begin',
      body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['gmail_read'] },
    });
    const state = new URL(JSON.parse(begin.text).data.authorization_url).searchParams.get('state') ?? '';
    const forged = await call({
      method: 'POST',
      path: '/oauth/complete',
      body: { address: 'http://127.0.0.1:53682/callback?state=forged&code=abc' },
    });
    expect(forged.status).toBe(400);
    expect(JSON.parse(forged.text).error.message).toContain('does not belong to the connection in progress');
    const real = await call({
      method: 'POST',
      path: '/oauth/complete',
      body: { address: `http://127.0.0.1:53682/callback?state=${state}&code=abc` },
    });
    expect(real.status).toBe(200);
  });

  it("refuses another user's state", async () => {
    const begin = await call({
      method: 'POST',
      path: '/oauth/begin',
      as: 'grace',
      body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['gmail_read'] },
    });
    const state = new URL(JSON.parse(begin.text).data.authorization_url).searchParams.get('state') ?? '';
    const done = await call({
      method: 'POST',
      path: '/oauth/complete',
      as: 'ada',
      body: { address: `http://127.0.0.1:53682/callback?state=${state}&code=abc` },
    });
    expect(done.status).toBe(400);
    expect(JSON.parse((await call({ method: 'GET', path: '/status', as: 'ada' })).text).data.state).toBe(
      'not_connected',
    );
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

  describe('the browser callback', () => {
    const origin = 'http://localhost:8791';
    const callback = (query: string, as = 'ada') =>
      app.request(`${origin}${BASE}/oauth/callback?${query}`, { headers: { 'x-test-user': as } });

    async function begin(as = 'ada') {
      const started = await call({
        origin,
        method: 'POST',
        path: '/oauth/begin',
        as,
        body: { client: { client_id: ID, client_secret: SECRET, client_type: 'desktop' }, features: ['gmail_read'] },
      });
      return new URL(JSON.parse(started.text).data.authorization_url).searchParams.get('state') ?? '';
    }

    it('says access was not granted when the user declined, with one next step', async () => {
      const response = await callback('error=access_denied');
      expect(response.status).toBe(400);
      const page = await response.text();
      expect(page).toContain('Access was not granted, so Google was not connected.');
      expect(page).toContain('Go back to Aman and start again.');
      expect(page).not.toContain('access_denied');
    });

    it('refuses a forged state without spending the real attempt', async () => {
      const state = await begin();
      const forged = await callback('code=abc&state=forged');
      expect(forged.status).toBe(400);
      expect(await forged.text()).toContain('Go back to Aman and start again.');
      expect((await callback(`code=abc&state=${state}`)).status).toBe(200);
    });

    it('refuses a state that another user started', async () => {
      const state = await begin('grace');
      const response = await callback(`code=abc&state=${state}`, 'ada');
      expect(response.status).toBe(400);
      expect(JSON.parse((await call({ method: 'GET', path: '/status', as: 'ada' })).text).data.state).toBe(
        'not_connected',
      );
    });

    it('refuses a response with no code, in plain words', async () => {
      const response = await callback('state=abc');
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('The response from Google was incomplete.');
    });
  });

  it('checks a client and reports a problem in plain words, storing nothing', async () => {
    const bad = await call({
      method: 'POST',
      path: '/oauth/check-client',
      body: { client: { client_id: 'nope', client_secret: SECRET }, registered_redirect_uris: [] },
    });
    expect(bad.status).toBe(200);
    expect(JSON.parse(bad.text).data).toMatchObject({
      ok: false,
      problems: [{ code: 'invalid_client_id' }],
    });
    expect(JSON.parse((await call({ method: 'GET', path: '/status' })).text).data.has_saved_client).toBe(false);
  });

  it('says a stored login needs reconnecting when Google no longer accepts it', async () => {
    await connect();
    revoked = true;
    const test = await call({ method: 'POST', path: '/test' });
    expect(JSON.parse(test.text).data).toEqual({ result: 'needs_reconnect', account_email: null });
    expect(JSON.parse((await call({ method: 'GET', path: '/status' })).text).data.state).toBe('needs_reconnect');
  });

  it('tests the connection and disconnects, revoking at Google first', async () => {
    await connect();
    const test = await call({ method: 'POST', path: '/test' });
    expect(JSON.parse(test.text).data).toEqual({ result: 'ok', account_email: 'ada@example.com' });
    const gone = await call({ method: 'POST', path: '/disconnect' });
    expect(JSON.parse(gone.text).data).toEqual({ revocation_confirmed: true });
    expect(calls.filter(entry => entry.includes('/revoke'))).toHaveLength(1);
    expect(JSON.parse((await call({ method: 'GET', path: '/status' })).text).data.state).toBe('not_connected');
  });
});

describe('Google connection API authentication', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer({ authenticator: headerAuthenticator });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it.each([
    ['GET', '/status'],
    ['POST', '/oauth/check-client'],
    ['POST', '/oauth/begin'],
    ['GET', '/oauth/callback?code=a&state=b'],
    ['POST', '/oauth/complete'],
    ['POST', '/test'],
    ['POST', '/disconnect'],
  ])('answers 401 to an unauthenticated %s %s', async (method, path) => {
    const response = await server.request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    expect(response.status).toBe(401);
  });

  it.each([
    ['GET', '/status'],
    ['POST', '/test'],
    ['POST', '/disconnect'],
  ])('refuses a bearer credential on %s %s, even with a signed-in user header', async (method, path) => {
    const response = await server.request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': 'ada', authorization: 'Bearer agent-token' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    expect(response.status).toBe(401);
  });

  it('serves the status to a signed-in caller', async () => {
    const response = await server.request(`${BASE}/status`, { headers: { 'x-test-user': 'ada' } });
    expect(response.status).toBe(200);
  });
});
