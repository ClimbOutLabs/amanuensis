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

  // Allow leads on every kind, safe-first ones too; a safe-first card keeps its safe words on the last choice.
  const kinds: { testId: string; no: string }[] = [
    { testId: 'kind-calendar', no: 'Keep it' },
    { testId: 'kind-email', no: "Don't send" },
    { testId: 'kind-payment', no: 'Keep it' },
    { testId: 'kind-file', no: 'Not now' },
    { testId: 'kind-sandbox', no: 'Not now' },
  ];
  for (const { testId, no } of kinds) {
    const card = page.getByTestId(testId);
    const order = await buttonOrder(card);
    assert.equal(order[0], 'Allow', `${testId} does not lead with Allow: ${order.join(', ')}`);
    assert.equal(order.at(-1), no, `${testId} does not end with ${no}: ${order.join(', ')}`);
  }

  // No choice is filled or inked: every button in every row has the same outlined look.
  const looks = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.aui-approval-card__actions button')).map(button => {
      const style = getComputedStyle(button);
      return { label: button.innerText.trim(), background: style.backgroundColor, color: style.color };
    }),
  );
  const first = looks[0];
  assert.ok(first !== undefined, 'no approval buttons rendered');
  for (const look of looks) {
    assert.equal(look.background, first.background, `"${look.label}" is filled differently from "${first.label}"`);
    assert.equal(look.color, first.color, `"${look.label}" has a different ink from "${first.label}"`);
  }

  // The reason shows on its own line under the question, with nothing to open.
  const calendar = page.getByTestId('kind-calendar');
  const reason = 'Aman always asks before deleting an event in this calendar.';
  assert.equal(await calendar.getByText(reason).isVisible(), true, 'the reason line does not show under the question');
}

test('every approval card kind fits a phone and a desktop, Allow first', { timeout: 240_000 }, async () => {
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
