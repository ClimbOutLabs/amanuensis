import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.js';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const THEMES = ['light', 'dark'] as const;
const LIST_NAME = 'Which notes each persona can read';

/** Opens Settings > Memory > Sharing from the shell, the way a person reaches it. */
async function openSharingTab(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await page.getByRole('tab', { name: 'Sharing' }).click();
  await page.getByRole('list', { name: LIST_NAME }).waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/** Scrolls the last persona row to the end of its scroll area and returns its box and the footer's top edge. */
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

type Box = { left: number; right: number; top: number; bottom: number };

/** Opens the first row's choices and measures the settings scroll area, the list, that row's name and button, and each choice. */
async function sharingGeometry(page: Page): Promise<{ panel: Box; list: Box; name: Box; button: Box; choices: Box[] }> {
  const list = page.getByRole('list', { name: LIST_NAME });
  await list
    .getByRole('button', { name: /^Select what / })
    .first()
    .click();
  await list.getByRole('checkbox').first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  // Plain rects only: a named helper here would be rewritten by the test transform and fail in the page.
  return await list.evaluate(element => {
    let panelElement: Element | null = element.parentElement;
    while (panelElement !== null && !['auto', 'scroll'].includes(getComputedStyle(panelElement).overflowY)) {
      panelElement = panelElement.parentElement;
    }
    if (panelElement === null) throw new Error('No scrolling settings panel around the sharing list');
    const row = element.querySelector('li');
    const button = row?.querySelector('button');
    const name = button?.previousElementSibling;
    if (row === null || button == null || name == null) throw new Error('The first sharing row is incomplete');
    return {
      panel: panelElement.getBoundingClientRect().toJSON(),
      list: element.getBoundingClientRect().toJSON(),
      name: name.getBoundingClientRect().toJSON(),
      button: button.getBoundingClientRect().toJSON(),
      choices: Array.from(row.querySelectorAll('label')).map(choice => choice.getBoundingClientRect().toJSON()),
    };
  });
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * The list sits inside the settings panel and its choices wrap inside it, so nothing widens the
 * page. No choice covers the persona's name, its button or another choice.
 */
function assertListInsidePanel(geometry: Awaited<ReturnType<typeof sharingGeometry>>, label: string) {
  assert.ok(geometry.choices.length > 0, `there are choices to check (${label})`);
  assert.ok(
    geometry.list.left >= geometry.panel.left && geometry.list.right <= geometry.panel.right,
    `the list ${JSON.stringify(geometry.list)} runs past the panel ${JSON.stringify(geometry.panel)} (${label})`,
  );
  assert.ok(!overlaps(geometry.name, geometry.button), `the button covers the persona's name (${label})`);
  geometry.choices.forEach((choice, index) => {
    assert.ok(
      choice.left >= geometry.list.left && choice.right <= geometry.list.right,
      `choice ${index} runs past the list (${label})`,
    );
    assert.ok(!overlaps(choice, geometry.name), `choice ${index} covers the persona's name (${label})`);
    assert.ok(!overlaps(choice, geometry.button), `choice ${index} covers the button (${label})`);
    for (const other of geometry.choices.slice(index + 1)) {
      assert.ok(!overlaps(choice, other), `two choices overlap (${label})`);
    }
  });
}

test(
  'the sharing list stays inside the panel, an open row keeps its choices clear of the name and each other, and the last row clears the footer, at desktop and phone width',
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
          await page.goto(`${fixtureUrl}?mode=${theme}`, {
            waitUntil: 'domcontentloaded',
            timeout: FIRST_LOAD_TIMEOUT_MS,
          });
          await openSharingTab(page);

          // The row of memory tabs stays whole above the grid, so the other tabs can still be reached.
          const tabs = page.getByRole('tablist', { name: 'Memory sections' });
          const tabsBox = await tabs.boundingBox();
          const tabBox = await tabs.getByRole('tab', { name: 'Memories' }).boundingBox();
          assert.ok(tabsBox !== null && tabBox !== null, `the memory tabs are on screen (${viewport.name} ${theme})`);
          assert.ok(
            tabBox.height >= 32 && tabsBox.height >= tabBox.height,
            `the memory tabs are squeezed: the row is ${tabsBox.height}px and a tab is ${tabBox.height}px (${viewport.name} ${theme})`,
          );

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
          assertListInsidePanel(await sharingGeometry(page), `${viewport.name} ${theme}`);
          assert.ok(
            (await page.evaluate(() => document.documentElement.scrollWidth)) <= viewport.width,
            `an open sharing row overflows horizontally at ${viewport.name} ${theme}`,
          );

          await page.screenshot({
            path: await featureShotPath({
              surface: 'screen:memory-sharing',
              step: `${viewport.name}-${theme}`,
            }),
          });
          await context.close();
        }
      }
    } catch (error) {
      await saveFailureShots({ browser, surface: 'screen:memory-sharing' });
      throw error;
    } finally {
      await browser?.close();
      await server.close();
      viteCache.remove();
    }
  },
);
