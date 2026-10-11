import { OpenAPIHono } from '@hono/zod-openapi';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { APP_SHELL_IMAGE_CSP, mountFrontend } from '../../src/frontend';

function buildDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'trueforge-frontend-'));
  writeFileSync(path.join(dir, 'index.html'), '<html><body><div id="root"></div></body></html>');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log("app");');
  return dir;
}

function appWithFrontend(dir: string): OpenAPIHono {
  const app = new OpenAPIHono();
  app.get('/api/v1/health', c => c.json({ ok: true }));
  mountFrontend(app, { dir, uiBasePath: '/' });
  return app;
}

const HTML_ACCEPT = { accept: 'text/html,application/xhtml+xml' };

describe('mountFrontend', () => {
  it('reports whether the directory holds a build', () => {
    expect(
      mountFrontend(new OpenAPIHono(), {
        dir: path.join(tmpdir(), 'trueforge-missing-build'),
        uiBasePath: '/',
      }),
    ).toBe(false);
    expect(mountFrontend(new OpenAPIHono(), { dir: buildDir(), uiBasePath: '/' })).toBe(true);
  });

  it('substitutes the public UI prefix into the cached app shell', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trueforge-frontend-'));
    writeFileSync(
      path.join(dir, 'index.html'),
      "<html><script>window.__TRUEFORGE_BASE_PATH__='%%TRUEFORGE_BASE_PATH%%';</script></html>",
    );
    const app = new OpenAPIHono();
    mountFrontend(app, { dir, uiBasePath: '/custom/proxy/path/' });

    const response = await app.request('/', { headers: HTML_ACCEPT });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("window.__TRUEFORGE_BASE_PATH__='/custom/proxy/path/'");
  });

  it('serves the app shell for client-only deep links', async () => {
    const app = appWithFrontend(buildDir());

    for (const clientPath of [
      '/',
      '/settings',
      '/library',
      '/library/agent-1',
      '/sessions/abc123',
      '/agents/my-agent',
    ]) {
      const response = await app.request(clientPath, { headers: HTML_ACCEPT });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('id="root"');
    }
  });

  it('keeps real files, API routes, and missing assets intact', async () => {
    const app = appWithFrontend(buildDir());

    const asset = await app.request('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toContain('console.log');

    const api = await app.request('/api/v1/health', { headers: HTML_ACCEPT });
    expect(api.status).toBe(200);
    await expect(api.json()).resolves.toEqual({ ok: true });

    // A missing asset must 404 rather than receive HTML under a JS content type.
    expect((await app.request('/assets/gone-000000.js')).status).toBe(404);

    // Navigations are the only thing the shell answers.
    expect((await app.request('/sessions/abc123', { method: 'POST', headers: HTML_ACCEPT })).status).toBe(404);
  });
});

describe('mountFrontend security headers', () => {
  it('sends an image-and-media-only CSP and no-referrer on the app shell', async () => {
    const app = appWithFrontend(buildDir());

    for (const shellPath of ['/', '/index.html', '/sessions/abc123']) {
      const response = await app.request(shellPath, { headers: HTML_ACCEPT });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(APP_SHELL_IMAGE_CSP);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('keeps the Vite index.html meta CSP equal to the served header', () => {
    // packages/frontend/index.html cannot import the constant, so the
    // equality is asserted here instead of shared by import.
    const indexPath = path.resolve(__dirname, '../../../frontend/index.html');
    const html = readFileSync(indexPath, 'utf-8');
    const match = html.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(APP_SHELL_IMAGE_CSP);
  });
});
