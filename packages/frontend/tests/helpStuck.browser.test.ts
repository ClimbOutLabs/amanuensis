import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;
const HELP_BUTTON = /Help, I'm stuck/;

/** One press of the top-bar button, with the words the help chat must show for that case. */
const CASES = [
  {
    name: 'ready model and Iris',
    query: 'health=ready&iris=joined',
    line: null,
    // The results are on screen in the new chat; the words below prove the chat is the one the press opened.
    results: ['Quick health check', 'You were on: Chat.'],
  },
  {
    name: 'health check fails',
    query: 'health=fail&iris=joined',
    line: 'The check could not run. Check your connection, then press Check again.',
    results: ['Quick health check'],
  },
  {
    name: 'no model',
    query: 'health=no_model&iris=joined',
    line: 'Add a model to get started. Token Factory is one option.',
    results: ['Quick health check'],
  },
  {
    name: 'Iris cannot join',
    query: 'health=ready&iris=missing',
    line: 'Iris could not join this chat. Run aman doctor on your computer, then press Check again.',
    results: ['Quick health check'],
  },
] as const;

async function screenshotDir(): Promise<string> {
  const configured = process.env.AMAN_SCREENSHOT_DIR;
  if (configured != null && configured !== '') {
    await mkdir(configured, { recursive: true });
    return configured;
  }
  return await mkdtemp(join(tmpdir(), 'aman-help-stuck-'));
}

test("Help, I'm stuck opens the help chat in every case, never a blank page", { timeout: 300_000 }, async () => {
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
  const outDir = await screenshotDir();

  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
    const fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/help-stuck.fixture.html`;

    browser = await chromium.launch({
      executablePath: findChromiumExecutable(chromium.executablePath()),
      headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

    for (const testCase of CASES) {
      const page: Page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      try {
        await page.goto(`${fixtureUrl}?${testCase.query}`, {
          waitUntil: 'domcontentloaded',
          timeout: RENDER_TIMEOUT_MS,
        });
        const button = page.getByRole('button', { name: HELP_BUTTON }).first();
        await button.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
        await button.click();

        const results = page.getByTestId('help-chat-results');
        await results.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
        for (const text of testCase.results) {
          await results.getByText(text, { exact: false }).waitFor({ timeout: RENDER_TIMEOUT_MS });
        }
        if (testCase.line !== null) {
          await page.getByRole('status').filter({ hasText: testCase.line }).waitFor({ timeout: RENDER_TIMEOUT_MS });
        }
        // Give a crash loop time to show itself before the page is judged.
        await page.waitForTimeout(1_500);
        assert.deepEqual(pageErrors, [], `${testCase.name}: the page should not throw`);
        assert.ok(await results.isVisible(), `${testCase.name}: the help panel should still be on screen`);
        await page.screenshot({
          path: join(outDir, `help-stuck-${testCase.name.replace(/\W+/g, '-')}.png`),
          fullPage: true,
        });
      } finally {
        await page.close();
      }
    }
    console.log(`help screenshots written to ${outDir}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});
