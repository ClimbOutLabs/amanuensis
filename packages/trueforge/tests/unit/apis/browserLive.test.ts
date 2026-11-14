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
const originalBrowserEnabled = configuration.BROWSER_ENABLED;

beforeEach(() => {
  Object.assign(configuration, {
    BROWSER_ENABLED: true,
    BROWSER_URL: 'http://browser-relay:8792',
    BROWSER_SECRET: SECRET,
  });
});

afterEach(() => {
  Object.assign(configuration, {
    BROWSER_ENABLED: originalBrowserEnabled,
    BROWSER_URL: originalBrowserUrl,
    BROWSER_SECRET: originalBrowserSecret,
  });
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
      data: { tabs: [{ tab: 'chat-1', title: 'Sign in', url: 'https://example.test/login' }], browser_on: true },
    });
    expect(sent).toEqual([
      {
        url: 'http://browser-relay:8792/live/tabs',
        headers: expect.objectContaining({ 'x-browser-secret': SECRET }),
        body: { owner: 'default:user-a' },
      },
    ]);
  });

  it('answers an empty list without asking the browser when the browser is off', async () => {
    Object.assign(configuration, { BROWSER_ENABLED: false });
    const { app, sent } = buildApp(() => ({ json: { status: 'ok', tabs: [] } }));
    const response = await call(app, { method: 'GET', path: '/api/browser/live/tabs' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { tabs: [], browser_on: false } });
    expect(sent).toEqual([]);
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

  it('forwards pasted text as a paste, not as typing', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/input',
      body: { tab: 'chat-1', kind: 'paste', text: 'line one\nline two' },
    });
    expect(response.status).toBe(200);
    expect(sent.map(entry => entry.body)).toEqual([
      { owner: 'default:user-a', tab: 'chat-1', kind: 'paste', text: 'line one\nline two' },
    ]);
  });

  it('refuses an empty or too long paste, without calling the sidecar', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    for (const text of ['', 'x'.repeat(10_001)]) {
      const response = await call(app, {
        method: 'POST',
        path: '/api/browser/live/input',
        body: { tab: 'chat-1', kind: 'paste', text },
      });
      expect(response.status).toBe(400);
    }
    expect(sent).toEqual([]);
  });

  it("copies the text selected in the caller's own tab", async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok', text: 'ORDER-12345' } }));
    const response = await call(app, { method: 'POST', path: '/api/browser/live/copy', body: { tab: 'chat-1' } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { text: 'ORDER-12345' } });
    expect(sent).toEqual([
      {
        url: 'http://browser-relay:8792/live/copy',
        headers: expect.objectContaining({ 'x-browser-secret': SECRET }),
        body: { owner: 'default:user-a', tab: 'chat-1' },
      },
    ]);
  });

  it('says what to do when nothing is selected, the selection is a password, or the tab closed', async () => {
    for (const [status, message] of [
      ['nothing_selected', 'Nothing is selected in the page. Select some text in the picture first.'],
      ['password', 'Passwords cannot be copied out of the page. Copy it from your password manager.'],
      ['closed', 'That tab has closed. Ask Aman to open the page again.'],
    ] as const) {
      const { app } = buildApp(() => ({ json: { status } }));
      const response = await call(app, { method: 'POST', path: '/api/browser/live/copy', body: { tab: 'chat-1' } });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: { message } });
      jest.restoreAllMocks();
    }
  });

  it('refuses a copy request that names the profile, without calling the sidecar', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok', text: 'x' } }));
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/copy',
      body: { tab: 'chat-1', owner: 'default:someone-else' },
    });
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("ends the session by closing the caller's own tab, and treats a tab already closed as ended", async () => {
    for (const status of ['ok', 'closed'] as const) {
      const { app, sent } = buildApp(() => ({ json: { status } }));
      const response = await call(app, { method: 'POST', path: '/api/browser/live/close', body: { tab: 'chat-1' } });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ data: { status: 'ok' } });
      expect(sent).toEqual([
        {
          url: 'http://browser-relay:8792/live/close',
          headers: expect.objectContaining({ 'x-browser-secret': SECRET }),
          body: { owner: 'default:user-a', tab: 'chat-1' },
        },
      ]);
      jest.restoreAllMocks();
    }
  });

  it('refuses a close request that names the profile, without calling the sidecar', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/close',
      body: { tab: 'chat-1', owner: 'default:someone-else' },
    });
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('forwards a pointer move, a press and a release from takeover', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok' } }));
    for (const body of [
      { tab: 'chat-1', kind: 'move', x: 30, y: 40, image_width: 640, image_height: 400 },
      { tab: 'chat-1', kind: 'down', x: 30, y: 40 },
      { tab: 'chat-1', kind: 'up', x: 35, y: 45 },
    ]) {
      const response = await call(app, { method: 'POST', path: '/api/browser/live/input', body });
      expect(response.status).toBe(200);
    }
    expect(sent.map(entry => entry.body)).toEqual([
      { owner: 'default:user-a', tab: 'chat-1', kind: 'move', x: 30, y: 40, image_width: 640, image_height: 400 },
      { owner: 'default:user-a', tab: 'chat-1', kind: 'down', x: 30, y: 40 },
      { owner: 'default:user-a', tab: 'chat-1', kind: 'up', x: 35, y: 45 },
    ]);
  });

  it("hands the caller's own tab over, and back, and says which hand holds it", async () => {
    const { app, sent } = buildApp(path =>
      path === '/live/takeover' ? { json: { status: 'ok', takeover: true } } : { json: { status: 'ok' } },
    );
    const response = await call(app, {
      method: 'POST',
      path: '/api/browser/live/takeover',
      body: { tab: 'chat-1', on: true },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { status: 'ok', takeover: true } });
    expect(sent).toEqual([
      {
        url: 'http://browser-relay:8792/live/takeover',
        headers: expect.objectContaining({ 'x-browser-secret': SECRET }),
        body: { owner: 'default:user-a', tab: 'chat-1', on: true },
      },
    ]);
  });

  it('refuses a takeover request that names the profile or is not a yes or no, without calling the sidecar', async () => {
    const { app, sent } = buildApp(() => ({ json: { status: 'ok', takeover: true } }));
    for (const body of [
      { tab: 'chat-1', on: true, owner: 'default:someone-else' },
      { tab: 'chat-1', on: 'yes' },
      { tab: 'chat-1' },
    ]) {
      const response = await call(app, { method: 'POST', path: '/api/browser/live/takeover', body });
      expect(response.status).toBe(400);
    }
    expect(sent).toEqual([]);
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
    for (const path of [
      '/api/browser/live/input',
      '/api/browser/live/frame',
      '/api/browser/live/copy',
      '/api/browser/live/close',
      '/api/browser/live/upload',
      '/api/browser/live/takeover',
    ]) {
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
