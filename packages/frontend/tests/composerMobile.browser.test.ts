import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { createServer } from 'vite';

function findChromiumExecutable(): string {
  const candidates: string[] = [];
  const add = (candidate: string | undefined) => {
    if (candidate != null && candidate.length > 0) candidates.push(candidate);
  };

  add(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  add(process.env.CHROME_PATH);
  add(process.env.EDGE_PATH);
  add(chromium.executablePath());

  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const localAppData = process.env.LOCALAPPDATA;
    if (programFiles != null) add(join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (programFilesX86 != null) {
      add(join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      add(join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (localAppData != null) {
      add(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      add(join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    add('/usr/bin/google-chrome');
    add('/usr/bin/google-chrome-stable');
    add('/usr/bin/chromium');
    add('/usr/bin/chromium-browser');
  }

  const executable = candidates.find(candidate => existsSync(candidate));
  if (executable == null) {
    throw new Error(
      'A Chromium browser is required. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, CHROME_PATH, or EDGE_PATH.',
    );
  }
  return executable;
}

test('320px composer keeps a touch-usable Send control inside the viewport', { timeout: 60_000 }, async () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const server = await createServer({
    configFile: false,
    root: frontendRoot,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser: Browser | undefined;

  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');

    browser = await chromium.launch({ executablePath: findChromiumExecutable(), headless: true });
    const context = await browser.newContext({
      viewport: { width: 320, height: 844 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/composer-mobile.fixture.html`);

    assert.equal(await page.evaluate(() => window.innerWidth), 320);
    for (const name of ['Add-ons (2)', 'Select model', 'Select reasoning effort', 'Send message']) {
      assert.equal(await page.getByRole('button', { name }).isVisible(), true, `${name} should be visible`);
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

    const cancel = page.getByRole('button', { name: 'Cancel' });
    assert.equal(await cancel.isVisible(), true);
    const cancelBox = await cancel.boundingBox();
    assert.ok(cancelBox != null, 'Cancel should have browser geometry while running');
    assert.ok(cancelBox.x >= 0, `Cancel starts outside viewport: ${cancelBox.x}`);
    assert.ok(cancelBox.x + cancelBox.width <= 320, `Cancel ends outside viewport: ${cancelBox.x + cancelBox.width}`);
    assert.ok(cancelBox.width >= 44, `Cancel width is below touch target: ${cancelBox.width}`);
    assert.ok(cancelBox.height >= 44, `Cancel height is below touch target: ${cancelBox.height}`);

    await cancel.tap();
    assert.equal(await page.locator('body').getAttribute('data-cancelled'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Send message' }).isVisible(), true);
  } finally {
    await browser?.close();
    await server.close();
  }
});
