import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const SURFACE = 'screen:notifications-panel';
/** The narrowest phone still in use, two common ones, and a laptop. */
const VIEWPORTS = [
  { width: 320, height: 700, phone: true },
  { width: 360, height: 780, phone: true },
  { width: 390, height: 844, phone: true },
  { width: 1280, height: 800, phone: false },
] as const;

/** Where the open panel lies against the window, so a failure names the side it ran off. */
async function panelOffScreen(page: Page): Promise<string[]> {
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await panel.waitFor({ state: 'visible', timeout: FIRST_LOAD_TIMEOUT_MS });
  const box = await panel.boundingBox();
  if (box === null) return ['the panel has no box on the screen'];
  const view = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const found: string[] = [];
  if (box.x < 0) found.push(`it starts ${String(Math.round(-box.x))}px past the left edge`);
  if (box.y < 0) found.push(`it starts ${String(Math.round(-box.y))}px above the top`);
  if (box.x + box.width > view.width) {
    found.push(`it ends ${String(Math.round(box.x + box.width - view.width))}px past the right edge`);
  }
  if (box.y + box.height > view.height) {
    found.push(`it ends ${String(Math.round(box.y + box.height - view.height))}px below the bottom`);
  }
  return found;
}

test(
  'the notifications panel opens fully on the screen, on a phone and on a laptop',
  { timeout: 600_000 },
  async () => {
    const api = await startApprovalTestServer();
    const viteCache = privateViteCache('notifications-panel');
    const vite = await createServer({
      cacheDir: viteCache.cacheDir,
      root: fileURLToPath(new URL('../', import.meta.url)),
      logLevel: 'error',
      plugins: [inProcessApi(api)],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    let browser: Browser | undefined;
    try {
      await vite.listen();
      const address = vite.httpServer?.address();
      if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
      const problems: string[] = [];

      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.phone,
          hasTouch: viewport.phone,
        });
        const page = await context.newPage();
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
        await page.locator('[data-slot="aui_composer-input"]').first().waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
        if (viewport.phone) {
          // On a phone the left panel sits in the drawer behind the Navigation button.
          await page.getByRole('button', { name: /^Navigation/ }).click();
        }
        const bell = page.locator('[data-role="delivery-bell"]:visible').first();
        await bell.waitFor({ state: 'visible', timeout: FIRST_LOAD_TIMEOUT_MS });
        await bell.click();
        for (const problem of await panelOffScreen(page)) problems.push(`${String(viewport.width)}px: ${problem}`);
        await page.screenshot({ path: await featureShotPath({ surface: SURFACE, step: String(viewport.width) }) });
        await context.close();
      }
      assert.deepEqual(problems, [], 'the open notifications panel stays inside the window');
    } catch (error) {
      await saveFailureShots({ browser, surface: SURFACE });
      throw error;
    } finally {
      await browser?.close();
      await vite.close();
      viteCache.remove();
      await api.close();
    }
  },
);
