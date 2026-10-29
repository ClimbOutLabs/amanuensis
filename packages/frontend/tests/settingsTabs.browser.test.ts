import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.js';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
/** Phone and large phone, the widths where the Settings tab strip scrolls. */
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 830, height: 900 },
] as const;
const THEMES = ['light', 'dark'] as const;

test('settings tabs highlight the section shown and stay reachable', { timeout: 300_000 }, async () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const viteCache = privateViteCache('settings-tabs');
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
    const fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/settings-tabs.fixture.html`;

    browser = await chromium.launch({
      executablePath: findChromiumExecutable(chromium.executablePath()),
      headless: true,
    });
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        await page.goto(`${fixtureUrl}?theme=${theme}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
        await checkSettingsPage(page, `${viewport.width}px ${theme}`);
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await server.close();
    viteCache.remove();
  }
});

/** The one tab that is selected, and the panel it labels, must be the section on screen. */
async function assertSelectedTab(page: Page, name: string, label: string) {
  const tablist = page.getByRole('tablist', { name: 'Settings sections' });
  const selected = tablist.locator('[role="tab"][aria-selected="true"]');
  assert.deepEqual(await selected.allTextContents(), [name], `${label}: only ${name} is highlighted`);
  const panelId = await page.getByRole('tabpanel').getAttribute('aria-labelledby');
  assert.equal(panelId, await selected.getAttribute('id'), `${label}: the panel is labelled by the highlighted tab`);
}

async function checkSettingsPage(page: Page, label: string) {
  const tablist = page.getByRole('tablist', { name: 'Settings sections' });
  await tablist.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });

  // A fresh open lands on Models, and the Settings header sits at the top of the page.
  await assertSelectedTab(page, 'Models', label);
  const header = page.locator('header').filter({ has: page.getByRole('heading', { name: 'Settings', exact: true }) });
  const headerBox = await header.boundingBox();
  assert.ok(
    headerBox !== null && headerBox.y <= 1,
    `${label}: the Settings header is at the top, not below a blank band`,
  );

  const names = await tablist.getByRole('tab').allTextContents();
  assert.ok(names.length >= 5, `${label}: the settings tabs render`);
  for (const name of names) {
    const tab = tablist.getByRole('tab', { name, exact: true });
    // Playwright scrolls the strip to reach a tab, so a click here also proves the tab can be reached.
    await tab.click();
    await assertSelectedTab(page, name, `${label} ${name}`);
    const tabBox = await tab.boundingBox();
    const stripBox = await tablist.boundingBox();
    assert.ok(tabBox !== null && stripBox !== null, `${label} ${name}: the tab and the strip have geometry`);
    assert.ok(
      tabBox.x >= stripBox.x - 1 && tabBox.x + tabBox.width <= stripBox.x + stripBox.width + 1,
      `${label} ${name}: the highlighted tab is inside the visible strip`,
    );
    assert.ok(
      (await page.evaluate(() => document.documentElement.scrollWidth)) <= (page.viewportSize()?.width ?? 0),
      `${label} ${name}: the page does not scroll sideways`,
    );
  }

  // Arrow keys move the selection and focus together, starting from the selected tab.
  await tablist.getByRole('tab', { name: 'Models', exact: true }).click();
  await tablist.getByRole('tab', { name: 'Models', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await assertSelectedTab(page, 'Roles and Personas', `${label} arrow key`);
  assert.ok(
    await tablist
      .getByRole('tab', { name: 'Roles and Personas', exact: true })
      .evaluate(el => el === document.activeElement),
    `${label}: the arrow key moves focus to the new tab`,
  );
}
