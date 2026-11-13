import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { MODEL_PROVIDER_NAME, startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
const SAVED_NAME = 'Robin Example';

interface PanelCheck {
  /** The feature id in tests/nightly-coverage.json. */
  surface: string;
  tab: string;
  /** Proves the panel shows what the server holds, and does the panel's own action where it has a safe one. */
  check: (input: { page: Page; panel: Locator }) => Promise<void>;
}

async function shows(target: Locator): Promise<void> {
  await target.first().waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
}

const PANELS: readonly PanelCheck[] = [
  {
    surface: 'settings:models',
    tab: 'Models',
    check: async ({ panel }) => {
      await shows(panel.getByRole('heading', { name: MODEL_PROVIDER_NAME, exact: true }));
      await shows(panel.getByText('Connected', { exact: true }));
    },
  },
  {
    surface: 'settings:model-roles',
    tab: 'Roles and Personas',
    check: async ({ panel }) => {
      await shows(panel.getByRole('heading', { name: 'Main chat model', exact: true }));
      await shows(panel.getByText('scripted-model', { exact: true }));
    },
  },
  {
    surface: 'settings:connectors',
    tab: 'Connectors',
    check: async ({ panel }) => {
      await shows(panel.getByRole('heading', { name: 'inert', exact: true }));
    },
  },
  {
    surface: 'settings:memory',
    tab: 'Memory',
    check: async ({ panel }) => {
      await shows(panel.getByRole('button', { name: 'Open Memory settings' }));
    },
  },
  {
    surface: 'settings:themes',
    tab: 'Themes',
    check: async ({ page, panel }) => {
      const dark = panel.getByRole('button', { name: 'Dark', exact: true });
      await shows(dark);
      // The heading's ink flips with the color mode, so its color is what a person would see change.
      const heading = panel.getByRole('heading', { name: 'Appearance', exact: true });
      const before = await heading.evaluate(el => getComputedStyle(el).color);
      await dark.click();
      await assert.doesNotReject(
        page.waitForFunction(
          was => {
            const title = document.querySelector('[role="tabpanel"] h1, [role="tabpanel"] h2, [role="tabpanel"] h3');
            return title !== null && getComputedStyle(title).color !== was;
          },
          before,
          { timeout: RENDER_TIMEOUT_MS },
        ),
        'choosing Dark changes the colors on screen',
      );
      assert.equal(await dark.getAttribute('aria-pressed'), 'true', 'Dark is the chosen color mode');
    },
  },
  {
    surface: 'settings:skills',
    tab: 'Skills',
    check: async ({ panel }) => {
      await shows(panel.getByRole('heading', { name: /^Available · [1-9]\d*$/ }));
    },
  },
  {
    surface: 'settings:sandbox',
    tab: 'Sandbox',
    check: async ({ panel }) => {
      await shows(panel.getByRole('heading', { name: 'Status', exact: true }));
      await shows(panel.getByText('Code execution is off', { exact: false }));
    },
  },
  {
    surface: 'settings:personalization',
    tab: 'Personalization',
    check: async ({ page, panel }) => {
      const name = panel.locator('#personalization-user-name');
      await shows(name);
      await name.fill(SAVED_NAME);
      const saved = page.waitForResponse(
        response => response.url().includes('/personalization') && response.request().method() !== 'GET',
        { timeout: RENDER_TIMEOUT_MS },
      );
      await panel.getByRole('button', { name: 'Save personalization' }).click();
      assert.ok((await saved).ok(), 'the server kept the name');
    },
  },
  {
    surface: 'settings:permissions',
    tab: 'Permissions',
    check: async ({ panel }) => {
      await shows(panel.getByText('Offline mode', { exact: true }));
    },
  },
  {
    surface: 'settings:audit',
    tab: 'Audit',
    check: async ({ panel }) => {
      await shows(panel.getByText('Nothing recorded yet.', { exact: true }));
    },
  },
  {
    surface: 'settings:reach-me',
    tab: 'Reach me',
    check: async ({ panel }) => {
      await shows(panel.getByRole('heading', { name: 'Notices on this device', exact: true }));
    },
  },
  {
    surface: 'settings:about',
    tab: 'About',
    check: async ({ panel }) => {
      await shows(panel.getByText(/^\d+\.\d+\.\d+/));
    },
  },
];

test(
  'every Settings panel opens against the real server, shows what it holds, and no request fails',
  { timeout: 600_000 },
  async () => {
    const api = await startApprovalTestServer();
    const viteCache = privateViteCache('settings-panels');
    const vite = await createServer({
      cacheDir: viteCache.cacheDir,
      root: fileURLToPath(new URL('../', import.meta.url)),
      logLevel: 'error',
      plugins: [inProcessApi(api)],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    let browser: Browser | undefined;
    let current = PANELS[0]?.surface ?? 'screen:settings-tabs';
    try {
      await vite.listen();
      const address = vite.httpServer?.address();
      if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const failures: string[] = [];
      page.on('response', response => {
        if (response.status() >= 400) {
          failures.push(`${current}: ${String(response.status())} ${response.request().method()} ${response.url()}`);
        }
      });
      page.on('pageerror', error => failures.push(`${current}: ${error.message}`));

      await page.goto(`${origin}/settings`, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
      const tablist = page.getByRole('tablist', { name: 'Settings sections' });
      await tablist.waitFor({ state: 'visible', timeout: FIRST_LOAD_TIMEOUT_MS });
      assert.deepEqual(
        await tablist.getByRole('tab').allTextContents(),
        PANELS.map(panel => panel.tab),
        'this test checks every Settings tab the app shows; add a check for a new tab',
      );

      for (const panel of PANELS) {
        current = panel.surface;
        await tablist.getByRole('tab', { name: panel.tab, exact: true }).click();
        await panel.check({ page, panel: page.getByRole('tabpanel') });
        await page.screenshot({ path: await featureShotPath({ surface: panel.surface, step: 'panel' }) });
      }

      // What Personalization saved is still there after the app loads again.
      current = 'settings:personalization';
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      await tablist.getByRole('tab', { name: 'Personalization', exact: true }).click();
      const name = page.getByRole('tabpanel').locator('#personalization-user-name');
      await name.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
      await page.waitForFunction(
        expected => document.querySelector<HTMLInputElement>('#personalization-user-name')?.value === expected,
        SAVED_NAME,
        { timeout: RENDER_TIMEOUT_MS },
      );
      await page.screenshot({ path: await featureShotPath({ surface: current, step: 'name-kept-after-reload' }) });

      assert.deepEqual(failures, [], 'no request failed and no page error was raised on any panel');
    } catch (error) {
      await saveFailureShots({ browser, surface: current });
      throw error;
    } finally {
      await browser?.close();
      await vite.close();
      viteCache.remove();
      await api.close();
    }
  },
);
