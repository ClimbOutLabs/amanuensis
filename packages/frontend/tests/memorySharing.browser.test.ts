import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.js';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const THEMES = ['light', 'dark'] as const;
const GRID_NAME = 'Which notes each persona can read';

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
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await page.getByRole('tab', { name: 'Sharing' }).click();
  await page.getByRole('table', { name: GRID_NAME }).waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/** Scrolls the last persona row to the end of its scroll area and returns its box and the footer's top edge. */
async function lastRowAboveFooter(page: Page): Promise<{ rowBottom: number; footerTop: number; viewport: number }> {
  const row: Locator = page.getByRole('table', { name: GRID_NAME }).getByRole('row').last();
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

type Box = { left: number; right: number; top: number; bottom: number };

/** Measures the settings scroll area, the grid's own sideways scroll box, each row's persona name, and each checkbox. */
async function sharingGeometry(
  page: Page,
): Promise<{ panel: Box; grid: Box; names: Box[]; boxes: Box[]; boxRows: Box[][] }> {
  const table = page.getByRole('table', { name: GRID_NAME });
  // Plain rects only: a named helper here would be rewritten by the test transform and fail in the page.
  const geometry = await table.evaluate(element => {
    let panelElement: Element | null = element.parentElement;
    while (panelElement !== null && !['auto', 'scroll'].includes(getComputedStyle(panelElement).overflowY)) {
      panelElement = panelElement.parentElement;
    }
    if (panelElement === null) throw new Error('No scrolling settings panel around the sharing grid');
    const gridElement = element.parentElement ?? element;
    const rows = Array.from(element.querySelectorAll('tbody > tr'));
    return {
      panel: panelElement.getBoundingClientRect().toJSON(),
      grid: gridElement.getBoundingClientRect().toJSON(),
      names: rows.map(row => (row.querySelector(':scope > th') ?? row).getBoundingClientRect().toJSON()),
      boxRows: rows.map(row =>
        Array.from(row.querySelectorAll('input[type="checkbox"]')).map(box => box.getBoundingClientRect().toJSON()),
      ),
    };
  });
  return {
    panel: geometry.panel,
    grid: geometry.grid,
    names: geometry.names,
    boxes: geometry.boxRows.flat(),
    boxRows: geometry.boxRows,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * The grid sits inside the settings panel and scrolls sideways in its own box when it is wider, so
 * no checkbox widens the page. No checkbox covers a persona name or another checkbox.
 */
function assertGridInsidePanel(geometry: Awaited<ReturnType<typeof sharingGeometry>>, label: string) {
  assert.ok(geometry.boxes.length > 0, `there are checkboxes to check (${label})`);
  assert.ok(
    geometry.grid.left >= geometry.panel.left && geometry.grid.right <= geometry.panel.right,
    `the grid ${JSON.stringify(geometry.grid)} runs past the panel ${JSON.stringify(geometry.panel)} (${label})`,
  );
  geometry.names.forEach((name, rowIndex) => {
    const rowBoxes = geometry.boxRows[rowIndex] ?? [];
    for (const box of rowBoxes) {
      assert.ok(!overlaps(name, box), `a checkbox covers the name in row ${rowIndex} (${label})`);
    }
    rowBoxes.forEach((box, boxIndex) => {
      for (const other of rowBoxes.slice(boxIndex + 1)) {
        assert.ok(!overlaps(box, other), `two checkboxes overlap in row ${rowIndex} (${label})`);
      }
    });
  });
}

test(
  'the sharing grid stays inside the panel, its checkboxes clear the persona names, and the last row clears the footer, at desktop and phone width',
  { timeout: 300_000 },
  async () => {
    const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
    const viteCache = privateViteCache('memory-sharing');
    const server = await createServer({
      cacheDir: viteCache.cacheDir,
      configFile: false,
      optimizeDeps: DEV_OPTIMIZE_DEPS,
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
          assertGridInsidePanel(await sharingGeometry(page), `${viewport.name} ${theme}`);

          await page.screenshot({ path: join(outDir, `memory-sharing-${viewport.name}-${theme}.png`) });
          await context.close();
        }
      }
    } finally {
      await browser?.close();
      await server.close();
      viteCache.remove();
    }
  },
);
