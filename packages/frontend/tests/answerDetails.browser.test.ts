import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;

test('answer details open and close from the keyboard', { timeout: 180_000 }, async () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const server = await createServer({
    configFile: false,
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
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/answer-details.fixture.html`, {
      waitUntil: 'domcontentloaded',
      timeout: RENDER_TIMEOUT_MS,
    });

    const toggle = page.getByRole('button', { name: 'Details' });
    const usage = page.getByTestId('answer-usage');
    await toggle.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await usage.isVisible(), false, 'usage shows before the details are opened');

    await page.keyboard.press('Tab');
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true, 'toggle is not focusable');

    await page.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await usage.isVisible(), true, 'Enter did not open the details');

    await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await usage.isVisible(), false, 'Space did not close the details');
  } finally {
    await browser?.close();
    await server.close();
  }
});
