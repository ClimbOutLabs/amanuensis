import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from 'winston';

import { createBrowserLiveRouter } from '../../../src/apis/browserLive';
import type { Authenticator } from '../../../src/auth/authenticator';
import { resolveRequestContext, type RequestContext } from '../../../src/auth/identity';
import { createUiSessionAuthMiddleware } from '../../../src/auth/middleware';
import configuration from '../../../src/config';

const SECRET = 'browser-test-secret-0123456789abcdef0123';
const USER: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'user-a', type: 'user', display_name: 'user-a' },
  roles: [],
  user_credential: null,
};

const cookieAuthenticator: Authenticator = {
  authenticate: c => {
    if (c.req.header('Cookie')?.includes('accessToken=') !== true) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    return Promise.resolve(USER);
  },
};

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** The router mounted as the app mounts it, with the sidecar answered by `reply` and every call to it recorded. */
function buildApp(reply: (path: string) => { status?: number; json: unknown }) {
  const sent: SentRequest[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : '{}';
    const body: unknown = JSON.parse(bodyText);
    sent.push({
      url,
      headers: Object.fromEntries(headers.entries()),
      body: typeof body === 'object' && body !== null ? Object.fromEntries(Object.entries(body)) : {},
    });
    const answer = reply(new URL(url).pathname);
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 });
  });
  const app = new Hono();
  app.use('*', createUiSessionAuthMiddleware(cookieAuthenticator));
  app.route(
    '/api/browser/live',
    createBrowserLiveRouter({ resolveRequestContext, logger: createLogger({ silent: true }) }),
  );
  return { app, sent };
}

const COOKIE = { Cookie: 'accessToken=test' };

async function call(
  app: Hono,
  input: { method: string; path: string; body?: Record<string, unknown>; headers?: Record<string, string> },
) {
  return app.request(input.path, {
    method: input.method,
    headers: { 'content-type': 'application/json', ...(input.headers ?? COOKIE) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

const originalBrowserUrl = configuration.BROWSER_URL;
const originalBrowserSecret = configuration.BROWSER_SECRET;

beforeEach(() => {
  Object.assign(configuration, { BROWSER_URL: 'http://browser-relay:8792', BROWSER_SECRET: SECRET });
});

afterEach(() => {
  Object.assign(configuration, { BROWSER_URL: originalBrowserUrl, BROWSER_SECRET: originalBrowserSecret });
  jest.restoreAllMocks();
});

describe('browser live routes', () => {
  it('refuses a caller with no browser session', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok', tabs: [] } }));
    const response = await call(app, { method: 'GET', path: '/api/browser/live/tabs', headers: {} });
    expect(response.status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("lists the signed-in person's tabs, addressed by their session profile and no tab", async () => {
    const { app, sent } = buildApp(() => ({
      json: { status: 'ok', tabs: [{ tab: 'chat-1', title: 'Sign in', url: 'https://example.test/login' }] },
    }));
    const response = await call(app, { method: 'GET', path: '/api/browser/live/tabs' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { tabs: [{ tab: 'chat-1', title: 'Sign in', url: 'https://example.test/login' }] },
    });
    expect(sent).toEqual([
      {
        url: 'http://browser-relay:8792/live/tabs',
        headers: expect.objectContaining({ 'x-browser-secret': SECRET }),
        body: { owner: 'default:user-a' },
      },
    ]);
  });

  it("returns one frame of the caller's own tab", async () => {
    const { app, sent } = buildApp(() => ({
      json: { status: 'ok', jpeg_base64: 'anBlZw==', width: 1280, height: 800 },
    }));
    const response = await call(app, { method: 'POST', path: '/api/browser/live/frame', body: { tab: 'chat-1' } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { status: 'ok', jpeg_base64: 'anBlZw==', width: 1280, height: 800 },
    });
    expect(sent[0]?.url).toBe('http://browser-relay:8792/live/frame');
    expect(sent[0]?.body).toEqual({ owner: 'default:user-a', tab: 'chat-1' });
  });

  it('reports a tab that is not open in their profile as closed, not as an error', async () => {
    const { app } = buildApp(() => ({ json: { status: 'closed' } }));
    const response = await call(app, { method: 'POST', path: '/api/browser/live/frame', body: { tab: 'chat-9' } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { status: 'closed' } });
  });

  it('never lets a request name the profile: an owner field in the body is refused', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok', jpeg_base64: 'anBlZw==' } }));
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/frame',
      body: { tab: 'chat-1', owner: 'default:someone-else' },
    });
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('forwards a click with the frame size it was read from', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/input',
      body: { tab: 'chat-1', kind: 'click', x: 10, y: 20, image_width: 640, image_height: 400 },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { status: 'ok' } });
    expect(sent[0]?.url).toBe('http://browser-relay:8792/live/input');
    expect(sent[0]?.body).toEqual({
      owner: 'default:user-a',
      tab: 'chat-1',
      kind: 'click',
      x: 10,
      y: 20,
      image_width: 640,
      image_height: 400,
    });
  });

  it('forwards typing, a key and a scroll step', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    for (const body of [
      { tab: 'chat-1', kind: 'type', text: '123456' },
      { tab: 'chat-1', kind: 'key', key: 'Enter' },
      { tab: 'chat-1', kind: 'wheel', dy: -240 },
    ]) {
      const response = await call(app, { method: 'POST', path: '/api/browser/live/input', body });
      expect(response.status).toBe(200);
    }
    expect(sent.map(entry => entry.body)).toEqual([
      { owner: 'default:user-a', tab: 'chat-1', kind: 'type', text: '123456' },
      { owner: 'default:user-a', tab: 'chat-1', kind: 'key', key: 'Enter' },
      { owner: 'default:user-a', tab: 'chat-1', kind: 'wheel', dy: -240 },
    ]);
  });

  it('refuses an input it does not know, without calling the sidecar', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/input',
      body: { tab: 'chat-1', kind: 'dance' },
    });
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("puts an uploaded file into the caller's own tab", async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/upload',
      body: { tab: 'chat-1', name: 'id.pdf', mime: 'application/pdf', data: 'JVBERi0=' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { status: 'ok' } });
    expect(sent).toEqual([
      {
        url: 'http://browser-relay:8792/live/upload',
        headers: expect.objectContaining({ 'x-browser-secret': SECRET }),
        body: { owner: 'default:user-a', tab: 'chat-1', name: 'id.pdf', mime: 'application/pdf', data: 'JVBERi0=' },
      },
    ]);
  });

  it('says so when the page has nowhere to put a file', async () => {
    const { app } = buildApp(() => ({ json: { status: 'no_file_field' } }));
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/upload',
      body: { tab: 'chat-1', name: 'id.pdf', mime: 'application/pdf', data: 'JVBERi0=' },
    });
    expect(response.status).toBe(409);
  });

  it('refuses an upload that names the profile or is too large, without calling the sidecar', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    for (const body of [
      { tab: 'chat-1', name: 'id.pdf', mime: 'application/pdf', data: 'JVBERi0=', owner: 'default:someone-else' },
      { tab: 'chat-1', name: 'big.bin', mime: 'application/octet-stream', data: 'A'.repeat(14_000_001) },
      { tab: 'chat-1', name: '', mime: 'text/plain', data: 'aGk=' },
    ]) {
      const response = await call(app, { method: 'POST', path: '/api/browser/live/upload', body });
      expect(response.status).toBe(400);
    }
    expect(sent).toEqual([]);
  });

  it('refuses an upload from a caller with no browser session', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/upload',
      body: { tab: 'chat-1', name: 'id.pdf', mime: 'application/pdf', data: 'JVBERi0=' },
      headers: {},
    });
    expect(response.status).toBe(401);
    expect(sent).toEqual([]);
  });
  it('refuses an agent or API token, even alongside a browser session', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok', tabs: [] } }));
    const response = await call(app, {
      method: 'GET',
      path: '/api/browser/live/tabs',
      headers: { ...COOKIE, Authorization: 'Bearer agent-token' },
    });
    expect(response.status).toBe(401);
    expect(sent).toEqual([]);
  });

  it('refuses a form posted from another site, without calling the sidecar', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    const formBody = JSON.stringify({ tab: 'chat-1', kind: 'type', text: 'x' });
    for (const path of ['/api/browser/live/input', '/api/browser/live/frame', '/api/browser/live/upload']) {
      const response = await app.request(`http://localhost${path}`, {
        method: 'POST',
        headers: { ...COOKIE, 'content-type': 'text/plain', origin: 'https://evil.example' },
        body: formBody,
      });
      expect(response.status).toBe(403);
    }
    expect(sent).toEqual([]);
  });
});
