import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { inProcessApi, pausedSession } from './support/approvalChat.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
const USER_TEXT = 'run:inert_write please';
const ALLOW = 'Allow';
const RECONNECTING = 'Reconnecting…';
const LOST = 'Connection lost. Check your network, then tap Retry.';
/** The chat only re-checks after a hide this long; a shorter tab switch is left alone. */
const LONG_HIDE_MS = 31_000;
const SESSION_API = '**/api/v1/sessions/**';

/**
 * Lets the test hide and show the page the way switching apps on a phone does. Plain text, because
 * a compiled function can reference helpers the page does not have.
 */
const PAGE_VISIBILITY_CONTROL = `
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  window.__setPageHidden = next => {
    hidden = next;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  window.__pageLoadMarker = Math.random();
`;

async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(next => {
    const setHidden: unknown = Reflect.get(window, '__setPageHidden');
    if (typeof setHidden !== 'function') throw new Error('page visibility control is missing');
    setHidden(next);
  }, hidden);
}

async function pageLoadMarker(page: Page): Promise<unknown> {
  return await page.evaluate(() => Reflect.get(window, '__pageLoadMarker'));
}

async function cutNetwork(page: Page): Promise<void> {
  await page.route(SESSION_API, route => route.abort('internetdisconnected'));
}

async function restoreNetwork(page: Page): Promise<void> {
  await page.unroute(SESSION_API);
}

/** What the chat shows that must survive a resync exactly once. */
async function chatCounts(page: Page): Promise<{ userMessages: number; allowButtons: number }> {
  return {
    userMessages: await page.locator('[data-role="user"]').getByText(USER_TEXT).count(),
    allowButtons: await page.getByRole('button', { name: ALLOW }).count(),
  };
}

test('the chat reconnects on its own after the page was in the background', { timeout: 600_000 }, async () => {
  const api = await startApprovalTestServer();
  const viteCache = privateViteCache('reconnect-after-background');
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    const ids = await pausedSession(api);
    const page = await context.newPage();
    await page.addInitScript({ content: PAGE_VISIBILITY_CONTROL });
    await page.goto(`${origin}/sessions/${ids.sessionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: RENDER_TIMEOUT_MS,
    });
    await page.getByRole('button', { name: ALLOW }).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    // Let the opening load settle so the baseline is what the chat keeps showing.
    await page.waitForTimeout(3_000);
    const baseline = await chatCounts(page);
    assert.ok(baseline.userMessages >= 1, 'the question is on screen');
    assert.ok(baseline.allowButtons >= 1, 'the approval card is on screen');
    const marker = await pageLoadMarker(page);

    await test.test('hidden, then visible with the network down, then the network returns', async () => {
      await setPageHidden(page, true);
      await cutNetwork(page);
      await page.waitForTimeout(LONG_HIDE_MS);
      await setPageHidden(page, false);

      await page.getByText(RECONNECTING).waitFor({ timeout: RENDER_TIMEOUT_MS });
      assert.equal(await page.getByText(LOST).count(), 0, 'no error while it is still reconnecting');
      // Before this fix, this return showed a "Connection lost" toast that promised a resync and never did it.
      assert.equal(await page.getByText('Connection lost', { exact: true }).count(), 0, 'no connection-lost toast');

      await restoreNetwork(page);
      await page.getByText(RECONNECTING).waitFor({ state: 'detached', timeout: RENDER_TIMEOUT_MS });
      await page.getByRole('button', { name: ALLOW }).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      await page.waitForTimeout(3_000);
      assert.deepEqual(await chatCounts(page), baseline, 'the same messages and approval card, once each');
      assert.equal(await pageLoadMarker(page), marker, 'the page itself was not reloaded');
    });

    await test.test('reconnecting keeps failing, then Retry brings the chat back', async () => {
      await cutNetwork(page);
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await page.getByText(RECONNECTING).waitFor({ timeout: RENDER_TIMEOUT_MS });
      await page.getByText(LOST).waitFor({ timeout: RENDER_TIMEOUT_MS });
      assert.equal(await page.getByRole('button', { name: 'Retry' }).count(), 1, 'one Retry button');

      await restoreNetwork(page);
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.getByText(LOST).waitFor({ state: 'detached', timeout: RENDER_TIMEOUT_MS });
      await page.getByRole('button', { name: ALLOW }).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      await page.waitForTimeout(3_000);
      assert.deepEqual(await chatCounts(page), baseline, 'the same messages and approval card, once each');
      assert.equal(await pageLoadMarker(page), marker, 'the page itself was not reloaded');
    });
  } finally {
    await browser?.close();
    await vite.close();
    viteCache.remove();
    await api.close();
  }
});
