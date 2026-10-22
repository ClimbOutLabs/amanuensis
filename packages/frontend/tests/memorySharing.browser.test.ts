import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { findChromiumExecutable } from './support/findChromiumExecutable.js';

const RENDER_TIMEOUT_MS = 45_000;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const THEMES = ['light', 'dark'] as const;
const LIST_NAME = 'Memory sharing by specialist';

async function screenshotDir(): Promise<string> {
  const configured = process.env.AMAN_SCREENSHOT_DIR;
  if (configured != null && configured !== '') {
    await mkdir(configured, { recursive: true });
    return configured;
  }
  return await mkdtemp(join(tmpdir(), 'aman-memory-sharing-'));
}

/** Opens Settings > Memory > Sharing from the shell, the way a person reaches it. */
async function openSharingTab(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('tab', { name: 'Sharing' }).click();
  await page.getByRole('list', { name: LIST_NAME }).waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/** Scrolls the last specialist row to the end of its scroll area and returns its box and the footer's top edge. */
async function lastRowAboveFooter(page: Page): Promise<{ rowBottom: number; footerTop: number; viewport: number }> {
  const row: Locator = page.getByRole('list', { name: LIST_NAME }).getByRole('listitem').last();
  await row.evaluate(element => element.scrollIntoView({ block: 'end' }));
  const footer = page.locator('footer').filter({ has: page.getByRole('button', { name: 'Settings', exact: true }) });
  const rowBox = await row.boundingBox();
  const footerBox = await footer.boundingBox();
  assert.ok(rowBox !== null && footerBox !== null, 'the last row and the footer bar are on screen');
  return {
    rowBottom: rowBox.y + rowBox.height,
    footerTop: footerBox.y,
    viewport: (await page.viewportSize())?.height ?? 0,
  };
}

test(
  'the last sharing row scrolls fully above the footer bar at desktop and phone width',
  { timeout: 300_000 },
  async () => {
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
      const fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/memory-sharing.fixture.html`;

      browser = await chromium.launch({
        executablePath: findChromiumExecutable(chromium.executablePath()),
        headless: true,
      });
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: 1,
            ...(viewport.name === 'phone' ? { hasTouch: true, isMobile: true } : {}),
          });
          const page = await context.newPage();
          await page.goto(`${fixtureUrl}?mode=${theme}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
          await openSharingTab(page);

          const { rowBottom, footerTop, viewport: viewportHeight } = await lastRowAboveFooter(page);
          assert.ok(
            rowBottom <= footerTop,
            `last row ends at ${rowBottom}px, below the footer top at ${footerTop}px (${viewport.name} ${theme})`,
          );
          assert.ok(rowBottom <= viewportHeight, `last row is off screen at ${viewport.name} ${theme}`);
          assert.ok(
            (await page.evaluate(() => document.documentElement.scrollWidth)) <= viewport.width,
            `sharing overflows horizontally at ${viewport.name} ${theme}`,
          );

          await page.screenshot({ path: join(outDir, `memory-sharing-${viewport.name}-${theme}.png`) });
          await context.close();
        }
      }
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
