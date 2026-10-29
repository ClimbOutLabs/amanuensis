import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { chromium, type Browser } from 'playwright-core';
import { createServer, defaultClientConditions, type Plugin } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.js';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i;

/** An invented 320 x 200 gradient, standing in for a re-encoded image. */
function gradientPng(): Buffer {
  const width = 320;
  const height = 200;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = Math.round((x / width) * 200) + 30;
      row[2 + x * 3] = Math.round((y / height) * 120) + 80;
      row[3 + x * 3] = 170;
    }
    rows.push(row);
  }
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Serves the space picture route the way the server does: an inert, same-origin PNG. */
function spacePictureRoute(png: Buffer, seen: string[]): Plugin {
  return {
    name: 'space-picture-route',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === undefined || !req.url.startsWith('/api/space-pictures')) {
          next();
          return;
        }
        seen.push(req.url);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        res.end(png);
      });
    },
  };
}

test(
  'space pictures: a picture from this chat renders in a space through the proxy, never direct',
  { timeout: 180_000 },
  async () => {
    const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
    const indexCsp = CSP_META.exec(readFileSync(join(frontendRoot, 'index.html'), 'utf8'))?.[1];
    const fixtureCsp = CSP_META.exec(
      readFileSync(join(frontendRoot, 'tests/fixtures/space-pictures.fixture.html'), 'utf8'),
    )?.[1];
    assert.ok(indexCsp !== undefined, 'index.html should carry a CSP');
    assert.equal(fixtureCsp, indexCsp, 'the fixture must run under the app shell image policy');
    assert.doesNotMatch(indexCsp, /img-src[^;]*(https?:|\*)/, 'img-src must not allow any remote host');

    const viteCache = privateViteCache('space-pictures');
    const seen: string[] = [];
    const server = await createServer({
      configFile: false,
      optimizeDeps: DEV_OPTIMIZE_DEPS,
      root: frontendRoot,
      cacheDir: viteCache.cacheDir,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
      resolve: {
        conditions: ['trueforge-dev', ...defaultClientConditions],
        alias: [
          {
            find: /^truefoundry-gateway-sdk(\/.*)?$/,
            replacement: fileURLToPath(new URL('../src/gatewaySdkStub.ts', import.meta.url)),
          },
        ],
        dedupe: ['react', 'react-dom', '@assistant-ui/core', '@assistant-ui/store', '@assistant-ui/react'],
      },
      plugins: [spacePictureRoute(gradientPng(), seen)],
    });
    let browser: Browser | undefined;

    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
      const origin = `http://127.0.0.1:${address.port}`;

      browser = await chromium.launch({
        executablePath: findChromiumExecutable(chromium.executablePath()),
        headless: true,
      });

      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const offOriginImages: string[] = [];
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
          return route.continue();
        }
        if (route.request().resourceType() === 'image') {
          offOriginImages.push(url);
        }
        return route.abort();
      });
      const page = await context.newPage();

      await page.goto(`${origin}/tests/fixtures/space-pictures.fixture.html`, {
        waitUntil: 'domcontentloaded',
        timeout: RENDER_TIMEOUT_MS,
      });

      const states = await page.waitForFunction(
        () => {
          const frame = document.querySelector('iframe');
          const doc = frame?.contentDocument;
          const proxy = doc?.querySelector('img[data-testid="proxy-picture"]');
          const direct = doc?.querySelector('img[data-testid="direct-picture"]');
          if (proxy === null || proxy === undefined || direct === null || direct === undefined) return null;
          if (!proxy.complete || !direct.complete) return null;
          return { proxyWidth: proxy.naturalWidth, directWidth: direct.naturalWidth };
        },
        { timeout: RENDER_TIMEOUT_MS },
      );
      const result = await states.jsonValue();
      assert.ok(result !== null, 'both frame pictures should finish loading');
      assert.ok(result.proxyWidth > 0, 'the proxied picture in the space frame should load');
      assert.equal(result.directWidth, 0, 'the direct outside link in the same frame should stay blank');
      assert.equal(seen.length, 1, 'the frame should ask the proxy once');
      assert.ok(
        seen[0]?.startsWith('/api/space-pictures?url=https%3A%2F%2Fupload.wikimedia.org'),
        'the proxy request should name the picture',
      );
      assert.equal(offOriginImages.length, 0, 'no image request should leave the page');
    } finally {
      await browser?.close();
      await server.close();
      viteCache.remove();
    }
  },
);
