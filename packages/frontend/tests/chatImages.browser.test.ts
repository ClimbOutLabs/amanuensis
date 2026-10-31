import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, defaultClientConditions, type Plugin } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
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

/** Serves the image route the way the server does: an inert, same-origin PNG, or a 404 for the broken id. */
function chatImageRoute(png: Buffer): Plugin {
  return {
    name: 'chat-image-route',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === undefined || !/^\/api\/chat-images\/sessions\/[^/]+\/images\/[0-9a-f]{32}$/.test(req.url)) {
          next();
          return;
        }
        // The fixture's BROKEN_ID is 'd' repeated.
        if (req.url.endsWith(`/${'d'.repeat(32)}`)) {
          res.writeHead(404);
          res.end();
          return;
        }
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

/** Clicks each button with this name in turn; a button that disappears after its click is one already shown. */
async function showEach(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name, exact: true });
  for (let left = await button.count(); left > 0; left -= 1) {
    await button.first().click();
    await page.waitForFunction(
      ([label, expected]) =>
        [...document.querySelectorAll('button')].filter(each => each.textContent === label).length < expected,
      [name, left],
      { timeout: RENDER_TIMEOUT_MS },
    );
  }
}

async function waitForImages(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    expected =>
      [...document.querySelectorAll<HTMLImageElement>('img[data-testid="aui-chat-image"]')].filter(
        img => img.complete && img.naturalWidth > 0,
      ).length >= expected,
    count,
    { timeout: RENDER_TIMEOUT_MS },
  );
}

test('chat images: no remote image request ever leaves the page', { timeout: 180_000 }, async () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const indexCsp = CSP_META.exec(readFileSync(join(frontendRoot, 'index.html'), 'utf8'))?.[1];
  const fixtureCsp = CSP_META.exec(
    readFileSync(join(frontendRoot, 'tests/fixtures/chat-images.fixture.html'), 'utf8'),
  )?.[1];
  assert.ok(indexCsp !== undefined, 'index.html should carry a CSP');
  assert.equal(fixtureCsp, indexCsp, 'the fixture must run under the app shell image policy');
  assert.doesNotMatch(indexCsp, /img-src[^;]*(https?:|\*)/, 'img-src must not allow any remote host');

  const viteCache = privateViteCache('chat-images');
  const server = await createServer({
    configFile: false,
    optimizeDeps: DEV_OPTIMIZE_DEPS,
    root: frontendRoot,
    cacheDir: viteCache.cacheDir,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    // Same resolution as the app: workspace packages load from source, one React instance.
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
    plugins: [chatImageRoute(gradientPng())],
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

    const screenshotDir = process.env['CHAT_IMAGES_SCREENSHOT_DIR'];
    for (const viewport of [
      { name: 'desktop', width: 1280, height: 900, isMobile: false },
      { name: 'phone', width: 390, height: 844, isMobile: true },
    ]) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile,
        hasTouch: viewport.isMobile,
        deviceScaleFactor: 1,
      });
      // Every off-origin request is refused so a slip cannot reach the network; image requests and any
      // request to the hosts the reply names are the ones that must never happen.
      const offOriginImages: string[] = [];
      const cspViolations: string[] = [];
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
          return route.continue();
        }
        if (route.request().resourceType() === 'image' || /example\.(com|org)/.test(new URL(url).host)) {
          offOriginImages.push(url);
        }
        return route.abort();
      });
      const page = await context.newPage();
      page.on('console', message => {
        if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text());
      });

      await page.goto(`${origin}/tests/fixtures/chat-images.fixture.html`, {
        waitUntil: 'domcontentloaded',
        timeout: RENDER_TIMEOUT_MS,
      });

      // Only the sandbox chart shows before anyone asks; every web picture waits behind a line.
      await waitForImages(page, 1);
      await page.waitForLoadState('networkidle', { timeout: RENDER_TIMEOUT_MS });
      await page.getByText('Image from example.com hidden').first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      assert.equal(await page.getByText('Image from example.com hidden').count(), 3, `${viewport.name}: reply lines`);
      await page.getByText('2 images from the email were not loaded.', { exact: true }).waitFor();
      assert.equal(
        await page.locator('img[data-testid="aui-chat-image"]').count(),
        1,
        `${viewport.name}: before asking`,
      );
      assert.ok(
        (await page.evaluate(() => document.documentElement.scrollWidth)) <= viewport.width,
        `${viewport.name}: chat images overflow horizontally`,
      );
      if (screenshotDir !== undefined) {
        mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({ path: join(screenshotDir, `chat-images-${viewport.name}.png`), fullPage: true });
      }

      // Showing the reply pictures loads the harbor photo; the broken copy leaves nothing behind.
      await showEach(page, 'Show image');
      await page.getByText('This image is too large to show. Ask for a smaller copy.').waitFor();
      await waitForImages(page, 2);
      assert.equal(
        await page.locator('a[href*="/images/dddddddd"]').count(),
        0,
        `${viewport.name}: broken image left a link`,
      );
      assert.equal(
        await page.evaluate(
          () => [...document.querySelectorAll('img')].filter(img => img.complete && img.naturalWidth === 0).length,
        ),
        0,
        `${viewport.name}: a broken image box is still on the page`,
      );
      await page.getByText('Sketch (image not shown)').waitFor();

      // Loading the email's pictures shows them as thumbnails in one row.
      await showEach(page, 'Load images');
      await waitForImages(page, 4);
      assert.equal(
        await page.locator('[data-testid="aui-email-images"] img').count(),
        2,
        `${viewport.name}: email thumbnails`,
      );
      const widths = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLImageElement>('img[data-testid="aui-chat-image"]')].map(
          img => img.getBoundingClientRect().width,
        ),
      );
      for (const width of widths) {
        // 10rem at the default 16px root, with a little room for borders.
        assert.ok(width >= 150 && width <= 170, `${viewport.name}: thumbnail is ${String(width)}px wide`);
      }
      if (screenshotDir !== undefined) {
        await page.screenshot({
          path: join(screenshotDir, `chat-images-${viewport.name}-approved.png`),
          fullPage: true,
        });
      }

      const sources = await page.evaluate(() => [...document.querySelectorAll('img')].map(img => img.src));
      for (const src of sources) {
        assert.ok(src.startsWith(`${origin}/api/chat-images/`), `${viewport.name}: unexpected image source ${src}`);
      }
      assert.deepEqual(offOriginImages, [], `${viewport.name}: the page requested a remote image`);
      assert.deepEqual(cspViolations, [], `${viewport.name}: the page tried to break the image policy`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await server.close();
    viteCache.remove();
  }
});
