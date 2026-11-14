import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { FINAL_TEXT } from '../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { inProcessApi, pausedSession } from './support/approvalChat.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const SURFACE = 'screen:phone-width';
/** The narrowest phone still in use, and a common one. */
const WIDTHS = [320, 390] as const;

/**
 * What a person could not see or press without scrolling sideways: text or a control that starts on the screen
 * and runs off its side. A strip that scrolls sideways on purpose, and anything parked fully off the screen, is fine.
 */
async function cutOff(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const found: string[] = [];
    if (document.documentElement.scrollWidth > width) {
      found.push(`the page is ${String(document.documentElement.scrollWidth)} wide`);
    }
    for (const element of document.querySelectorAll('button, a, input, textarea, select, [role="tab"], h1, h2, p')) {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (box.right <= 0 || box.left >= width) continue;
      if (box.left >= -1 && box.right <= width + 1) continue;
      // A named helper here would not survive the trip into the page, so the walk up is written in place.
      let scrollsSideways = false;
      for (let node = element.parentElement; node !== null && !scrollsSideways; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        scrollsSideways = (overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth;
      }
      if (scrollsSideways) continue;
      const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40);
      found.push(
        `${element.tagName.toLowerCase()} "${label}" spans ${String(Math.round(box.left))} to ${String(Math.round(box.right))}`,
      );
    }
    return found;
  });
}

test('at phone widths nothing on the main screens runs off the side', { timeout: 600_000 }, async () => {
  const api = await startApprovalTestServer();
  const viteCache = privateViteCache('phone-width');
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

    const waiting = await pausedSession(api, { earlierMessages: ['hello'] });
    const problems: string[] = [];

    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const check = async (screen: string): Promise<void> => {
        await page.screenshot({
          path: await featureShotPath({ surface: SURFACE, step: `${String(width)}-${screen}` }),
        });
        for (const problem of await cutOff(page)) problems.push(`${String(width)}px ${screen}: ${problem}`);
      };

      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
      await page.locator('[data-slot="aui_composer-input"]').first().waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
      await check('home');

      await page.goto(`${origin}/sessions/${waiting.sessionId}`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Waiting for you').first().waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
      await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
      await check('chat');

      await page.getByRole('button', { name: /^Navigation/ }).click();
      const menu = page.getByRole('dialog', { name: 'Navigation' });
      await menu.getByRole('button', { name: 'New chat' }).waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
      await check('menu');
      // The strip beside the menu is what a person taps to close it.
      await page.mouse.click(width - 8, 400);
      await menu.waitFor({ state: 'detached', timeout: FIRST_LOAD_TIMEOUT_MS });

      await page.goto(`${origin}/settings`, { waitUntil: 'domcontentloaded' });
      const tablist = page.getByRole('tablist', { name: 'Settings sections' });
      await tablist.waitFor({ state: 'visible', timeout: FIRST_LOAD_TIMEOUT_MS });
      const tabs = await tablist.getByRole('tab').allTextContents();
      assert.ok(tabs.length > 0, 'Settings shows its tabs');
      for (const tab of tabs) {
        await tablist.getByRole('tab', { name: tab, exact: true }).click();
        await page.getByRole('tabpanel').waitFor({ state: 'visible', timeout: FIRST_LOAD_TIMEOUT_MS });
        await check(`settings-${tab.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
      }
      await context.close();
    }
    assert.deepEqual(problems, [], 'nothing is cut off at the side of a phone screen');
  } catch (error) {
    await saveFailureShots({ browser, surface: SURFACE });
    throw error;
  } finally {
    await browser?.close();
    await vite.close();
    viteCache.remove();
    await api.close();
  }
});
