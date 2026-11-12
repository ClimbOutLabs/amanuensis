import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
const TOKEN = 'tok-invented-9f8e7d6c5b4a';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/** The visible button labels in one card's button row, in the order they appear. */
async function buttonOrder(card: Locator): Promise<string[]> {
  const buttons = card.locator('.aui-approval-card__actions').getByRole('button');
  const labels: string[] = [];
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (await button.isVisible()) labels.push((await button.innerText()).trim());
  }
  return labels;
}

async function checkKinds(page: Page, width: number): Promise<void> {
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(
    pageWidth <= width,
    `the page scrolls sideways: ${String(pageWidth)} px wide on a ${String(width)} px screen`,
  );

  const bodyText = await page.evaluate(() => document.body.innerText);
  assert.ok(!bodyText.includes(TOKEN), 'an internal id reached the page');

  // Safe-first kinds: the safe choice leads as the primary button; the action follows, not primary.
  const safeFirst: { testId: string; safe: string; action: string }[] = [
    { testId: 'kind-calendar', safe: 'Keep it', action: 'Allow' },
    { testId: 'kind-email', safe: "Don't send", action: 'Allow' },
    { testId: 'kind-payment', safe: 'Keep it', action: 'Allow' },
  ];
  for (const { testId, safe, action } of safeFirst) {
    const card = page.getByTestId(testId);
    const order = await buttonOrder(card);
    assert.equal(order[0], safe, `${testId} does not lead with the safe choice: ${order.join(', ')}`);
    assert.equal(order[1], action, `${testId} does not put the action second: ${order.join(', ')}`);
    const safeButton = card.getByRole('button', { name: safe, exact: true });
    assert.equal(
      await safeButton.getAttribute('data-approval-primary'),
      'true',
      `${testId} safe choice is not primary`,
    );
    const actionButton = card.getByRole('button', { name: action, exact: true });
    assert.equal(await actionButton.getAttribute('data-approval-primary'), null, `${testId} action is still primary`);
    const actionClass = await actionButton.getAttribute('class');
    assert.ok(
      actionClass !== null && actionClass.includes('text-failure-bg'),
      `${testId} action is not in the destructive ink`,
    );
  }

  // Reversible kinds keep the action primary.
  for (const testId of ['kind-file', 'kind-sandbox']) {
    const card = page.getByTestId(testId);
    const allow = card.getByRole('button', { name: 'Allow', exact: true });
    assert.equal(await allow.getAttribute('data-approval-primary'), 'true', `${testId} lost its primary action`);
  }

  // The reason shows on its own line under the question, with nothing to open.
  const calendar = page.getByTestId('kind-calendar');
  const reason = 'Aman always asks before deleting an event in this calendar.';
  assert.equal(await calendar.getByText(reason).isVisible(), true, 'the reason line does not show under the question');
}

test('every approval card kind fits a phone and a desktop, safe choice first', { timeout: 240_000 }, async () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const viteCache = privateViteCache('approval-card-kinds');
  const server = await createServer({
    cacheDir: viteCache.cacheDir,
    configFile: false,
    optimizeDeps: DEV_OPTIMIZE_DEPS,
    root: frontendRoot,
    logLevel: 'silent',
    resolve: { conditions: ['trueforge-dev', ...defaultClientConditions] },
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser: Browser | undefined;

  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');

    browser = await chromium.launch({
      executablePath: findChromiumExecutable(chromium.executablePath()),
      headless: true,
    });
    const page = await browser.newPage({ viewport: PHONE, isMobile: true, hasTouch: true });
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/approval-card-kinds.fixture.html`, {
      waitUntil: 'domcontentloaded',
      timeout: FIRST_LOAD_TIMEOUT_MS,
    });
    await page
      .getByTestId('kind-calendar')
      .getByRole('button', { name: 'Keep it', exact: true })
      .waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });

    await checkKinds(page, PHONE.width);

    await page.setViewportSize(DESKTOP);
    await checkKinds(page, DESKTOP.width);
  } finally {
    await browser?.close();
    await server.close();
    viteCache.remove();
  }
});
