import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;

test('320px composer keeps a touch-usable Send control inside the viewport', { timeout: 120_000 }, async () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const server = await createServer({
    configFile: false,
    root: frontendRoot,
    logLevel: 'silent',
    // The published ui dist leaves core modules external, so resolve them from source like the app does.
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
    const context = await browser.newContext({
      viewport: { width: 320, height: 844 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    // The fixture renders after its module graph loads, and a cold Vite dependency optimization
    // can hold the page's `load` event past Playwright's default. Wait for the document, then for
    // each control to render, instead of sampling visibility once before React has mounted.
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/composer-mobile.fixture.html`, {
      waitUntil: 'domcontentloaded',
      timeout: RENDER_TIMEOUT_MS,
    });

    assert.equal(await page.evaluate(() => window.innerWidth), 320);
    for (const name of ['Add-ons (2)', 'Select model', 'Select reasoning effort', 'Send message']) {
      await page.getByRole('button', { name }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
    }

    const send = page.getByRole('button', { name: 'Send message' });
    assert.equal(await send.isEnabled(), true);
    const sendBox = await send.boundingBox();
    assert.ok(sendBox != null, 'Send should have browser geometry');
    assert.ok(sendBox.x >= 0, `Send starts outside viewport: ${sendBox.x}`);
    assert.ok(sendBox.x + sendBox.width <= 320, `Send ends outside viewport: ${sendBox.x + sendBox.width}`);
    assert.ok(sendBox.width >= 44, `Send width is below touch target: ${sendBox.width}`);
    assert.ok(sendBox.height >= 44, `Send height is below touch target: ${sendBox.height}`);
    assert.ok(
      (await page.evaluate(() => document.documentElement.scrollWidth)) <= 320,
      'Composer overflows horizontally',
    );

    await send.tap();
    assert.equal(await page.locator('body').getAttribute('data-submitted'), 'true');

    const cancel = page.getByRole('button', { name: 'Stop' });
    await cancel.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
    const stopBox = await cancel.boundingBox();
    assert.ok(stopBox != null, 'Stop should have browser geometry while running');
    assert.ok(stopBox.x >= 0, `Stop starts outside viewport: ${stopBox.x}`);
    assert.ok(stopBox.x + stopBox.width <= 320, `Stop ends outside viewport: ${stopBox.x + stopBox.width}`);
    assert.ok(stopBox.width >= 44, `Stop width is below touch target: ${stopBox.width}`);
    assert.ok(stopBox.height >= 44, `Stop height is below touch target: ${stopBox.height}`);

    await cancel.tap();
    assert.equal(await page.locator('body').getAttribute('data-cancelled'), 'true');
    await page.getByRole('button', { name: 'Send message' }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
  } finally {
    await browser?.close();
    await server.close();
  }
});
