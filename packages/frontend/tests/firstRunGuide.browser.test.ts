import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

function findChromiumExecutable(): string {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    chromium.executablePath(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((candidate): candidate is string => candidate != null && candidate.length > 0);
  const executable = candidates.find(candidate => existsSync(candidate));
  if (executable == null) {
    throw new Error(
      'A Chromium browser is required. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, CHROME_PATH, or EDGE_PATH.',
    );
  }
  return executable;
}

const RENDER_TIMEOUT_MS = 45_000;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const THEMES = ['light', 'dark'] as const;

/** What the Settings card must show; the screenshot is taken only after this is on screen. */
const SETTINGS_EXPECTATION = { heading: 'Welcome to Aman', progress: '2 of 3 done.' } as const;

/** The tour's compact setup line, for each fixture state that opens the tour. */
const SUMMARY_EXPECTATIONS = {
  fresh: '0 of 3 set up →',
  half: '2 of 3 set up →',
} as const;

/** The tour's greeting, the first thing an ordinary new chat shows. Its words depend on the hour. */
const TOUR_HEADING = /^Good (morning|afternoon|evening)/;

async function screenshotDir(): Promise<string> {
  const configured = process.env.AMAN_SCREENSHOT_DIR;
  if (configured != null && configured !== '') {
    await mkdir(configured, { recursive: true });
    return configured;
  }
  return await mkdtemp(join(tmpdir(), 'aman-first-run-'));
}

async function checkChecklist(page: Page) {
  const card = page.getByTestId('aman-first-run-guide');
  await card.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
  await card.getByRole('heading', { name: SETTINGS_EXPECTATION.heading }).waitFor({ timeout: RENDER_TIMEOUT_MS });
  assert.match(
    await page.getByTestId('aman-first-run-progress').innerText(),
    new RegExp(SETTINGS_EXPECTATION.progress),
  );
  // Memory works out of the box, so the checklist never asks about it.
  assert.doesNotMatch(await card.innerText(), /memory/i);
}

/** The tour keeps only the count of set-up lines, linked to the first open one. */
async function checkTourSummary(page: Page, state: keyof typeof SUMMARY_EXPECTATIONS) {
  const summary = page.getByTestId('aman-first-run-summary');
  await summary.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
  assert.equal((await summary.innerText()).trim(), SUMMARY_EXPECTATIONS[state]);
  assert.equal(await page.getByTestId('aman-first-run-guide').count(), 0);
}

test('first-run screens render in light and dark at desktop and phone width', { timeout: 300_000 }, async () => {
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
    const fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/first-run-guide.fixture.html`;

    browser = await chromium.launch({ executablePath: findChromiumExecutable(), headless: true });
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        ...(viewport.name === 'phone' ? { hasTouch: true, isMobile: true } : {}),
      });
      const page = await context.newPage();
      for (const theme of THEMES) {
        const open = async (state: string) => {
          await page.goto(`${fixtureUrl}?state=${state}&theme=${theme}`, {
            waitUntil: 'domcontentloaded',
            timeout: RENDER_TIMEOUT_MS,
          });
          await page.locator(`[data-fixture-state="${state}"]`).waitFor({ timeout: RENDER_TIMEOUT_MS });
        };
        const shoot = async (state: string) => {
          assert.ok(
            (await page.evaluate(() => document.documentElement.scrollWidth)) <= viewport.width,
            `${state} overflows horizontally at ${viewport.name}`,
          );
          await page.screenshot({ path: join(outDir, `${state}-${viewport.name}-${theme}.png`), fullPage: true });
        };

        for (const state of ['fresh', 'half'] as const) {
          await open(state);
          await checkTourSummary(page, state);
          await shoot(state);
        }
        await open('settings');
        await checkChecklist(page);
        await shoot('settings');

        // Once every line is done the tour drops the checklist and keeps its headline.
        await open('done');
        await page.getByRole('heading', { name: TOUR_HEADING }).waitFor({ timeout: RENDER_TIMEOUT_MS });
        assert.equal(await page.getByTestId('aman-first-run-guide').count(), 0);
        await shoot('done');

        // Every capability granted: the full prompt set is on screen.
        await open('connected');
        await page
          .getByRole('button', { name: /Find forgotten subscriptions/ })
          .waitFor({ timeout: RENDER_TIMEOUT_MS });
        assert.ok(await page.getByRole('button', { name: /Handle your email/ }).isVisible());
        assert.ok(await page.getByRole('button', { name: /Reply to an email/ }).isVisible());
        await shoot('connected');

        // The Tour with an area chosen: its cards lead, and the chip shows it is chosen.
        await open('tour-focus');
        await page.getByRole('button', { name: /Help me clear my head/ }).waitFor({ timeout: RENDER_TIMEOUT_MS });
        assert.equal(
          await page.getByRole('button', { name: 'Focus and getting started' }).getAttribute('aria-pressed'),
          'true',
        );
        await shoot('tour-focus');
        // Nothing chosen: the capability tickets, and no chip is pressed.
        await open('tour-none');
        await page.getByRole('button', { name: /Handle your email/ }).waitFor({ timeout: RENDER_TIMEOUT_MS });
        assert.equal(await page.getByRole('button', { name: /Help me clear my head/ }).count(), 0);
        assert.equal(
          await page.getByRole('button', { name: 'Focus and getting started' }).getAttribute('aria-pressed'),
          'false',
        );
        await shoot('tour-none');
        // Hidden on request: the plain greeting, with a way back to the tour.
        await open('hidden');
        await page.getByRole('button', { name: 'Show the tour' }).waitFor({ timeout: RENDER_TIMEOUT_MS });
        assert.equal(await page.getByTestId('aman-tour').count(), 0);
        await shoot('hidden');

        await open('line');
        const line = page.getByTestId('aman-name-prompt');
        await line.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
        assert.match(await line.innerText(), /Aman does not know your name yet/);
        assert.equal(await page.getByTestId('aman-first-run-guide').count(), 0);
        await shoot('line');

        await open('panel');
        const nameField = page.getByLabel('Your name');
        await nameField.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
        const nameBox = await nameField.boundingBox();
        const assistantBox = await page.getByLabel('Name', { exact: true }).boundingBox();
        assert.ok(nameBox != null && assistantBox != null, 'both name fields should have geometry');
        assert.ok(nameBox.y < assistantBox.y, 'the owner name field comes before the assistant name field');
        await shoot('panel');
      }
      await context.close();
    }
    console.log(`first-run screenshots written to ${outDir}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});
