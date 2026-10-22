import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;

test('a read-only transcript user bubble keeps the 48rem reading measure', { timeout: 180_000 }, async () => {
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/user-bubble.fixture.html`, {
      waitUntil: 'domcontentloaded',
      timeout: RENDER_TIMEOUT_MS,
    });

    const bubble = page.locator('[data-slot="aui_user-message-content"]');
    await bubble.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
    const width = await bubble.evaluate(element => element.getBoundingClientRect().width);

    // 48rem at 16px per rem is 768px; without the variable the cap disappears and the bubble stretches far wider.
    assert.ok(Math.abs(width - 768) < 1, `bubble is ${width}px wide`);
  } finally {
    await browser?.close();
    await server.close();
  }
});
