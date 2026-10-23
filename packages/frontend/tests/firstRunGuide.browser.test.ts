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

/** The greeting's words depend on the hour, so only the shape is checked. */
const GREETING = /^Good (morning|afternoon|evening)/;

/** The seven rendered sizes the home allows, in px at 16px to the rem. */
const ALLOWED_FONT_SIZES = new Set(['28px', '17px', '15px', '14px', '13px', '12px']);

/** What each home state shows: the setup ticket's count, and the first-run lines around it. */
const EXPECTED = {
  fresh: { ticket: '0 of 3 done', firstRun: true, productivityGold: false },
  half: { ticket: '1 of 3 done', firstRun: true, productivityGold: false },
  done: { ticket: null, firstRun: false, productivityGold: false },
  brief: { ticket: null, firstRun: false, productivityGold: true },
  skipped: { ticket: null, firstRun: false, productivityGold: false },
} as const;

async function screenshotDir(): Promise<string> {
  const configured = process.env.AMAN_SCREENSHOT_DIR;
  if (configured != null && configured !== '') {
    await mkdir(configured, { recursive: true });
    return configured;
  }
  return await mkdtemp(join(tmpdir(), 'aman-first-run-'));
}

async function checkHome(page: Page, state: keyof typeof EXPECTED) {
  const expected = EXPECTED[state];
  assert.match(await page.getByRole('heading', { level: 1, name: GREETING }).innerText(), GREETING);
  assert.equal(await page.getByRole('list', { name: 'What would help you most?' }).getByRole('button').count(), 6);
  assert.equal(await page.getByRole('button', { name: /^Some things|Draft a reply/ }).count(), 1);
  const ticket = page.getByTestId('aman-setup-ticket');
  if (expected.ticket === null) {
    assert.equal(await ticket.count(), 0, `${state} shows no setup ticket`);
  } else {
    assert.ok(await ticket.isVisible(), `${state} shows the setup ticket`);
    assert.ok((await ticket.innerText()).includes(expected.ticket), `${state} ticket reads ${expected.ticket}`);
  }
  const firstRunLine = await page.getByText('What would help you most? Pick one').count();
  assert.equal(firstRunLine, expected.firstRun ? 1 : 0, `${state} first-run prompt line`);
  const skip = await page.getByRole('button', { name: 'Skip the tour' }).count();
  assert.equal(skip, expected.firstRun ? 1 : 0, `${state} Skip shows only on a first run`);
  const productivityClass = (await page.getByRole('button', { name: 'Productivity' }).getAttribute('class')) ?? '';
  assert.equal(productivityClass.includes('bg-gold-soft'), expected.productivityGold, `${state} Productivity gold`);
}

async function checkSizes(page: Page) {
  const sizes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-fixture-state] *'))
      .filter(el =>
        Array.from(el.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()),
      )
      .map(el => getComputedStyle(el).fontSize),
  );
  const unexpected = [...new Set(sizes)].filter(size => !ALLOWED_FONT_SIZES.has(size));
  assert.deepEqual(unexpected, [], 'the home renders only the seven sizes in the type system');
}

test('home screens render in light and dark at desktop and phone width', { timeout: 300_000 }, async () => {
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
          await page.getByRole('heading', { level: 1, name: GREETING }).waitFor({ timeout: RENDER_TIMEOUT_MS });
          // Let the settle animation finish so the picture shows the resting frame.
          await page.waitForFunction(() =>
            document.getAnimations().every(animation => animation.playState !== 'running'),
          );
        };
        const shoot = async (state: string) => {
          assert.ok(
            (await page.evaluate(() => document.documentElement.scrollWidth)) <= viewport.width,
            `${state} overflows horizontally at ${viewport.name}`,
          );
          await page.screenshot({ path: join(outDir, `${state}-${viewport.name}-${theme}.png`), fullPage: true });
        };

        for (const state of ['fresh', 'half', 'done', 'brief', 'skipped'] as const) {
          await open(state);
          await checkHome(page, state);
          await checkSizes(page);
          await shoot(state);
        }

        // Skip hides the prompt line, the ticket and itself; the pills and the four cards stay.
        await open('fresh');
        await page.getByRole('button', { name: 'Skip the tour' }).click();
        await page.getByRole('heading', { level: 1, name: GREETING }).waitFor({ timeout: RENDER_TIMEOUT_MS });

        // The real shell: the top bar, the home and the composer share one screen with no page scroll.
        await open('shell');
        await page
          .getByRole('button', { name: /Draft a reply/ })
          .waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
        await shoot('shell');
        assert.ok(
          (await page.evaluate(() => document.documentElement.scrollHeight)) <= viewport.height,
          `the home scrolls the page at ${viewport.name} ${theme}`,
        );
        // Four cards: a row of four on desktop, one column on the phone.
        const cardLefts = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-fixture-state="shell"] ul.grid > li')).map(el =>
            Math.round(el.getBoundingClientRect().left),
          ),
        );
        assert.equal(cardLefts.length, 4, 'four cards');
        assert.equal(new Set(cardLefts).size, 2, 'the cards sit in a two-column grid');
      }
      await context.close();
    }
    console.log(`home screenshots written to ${outDir}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});
