import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PRESETS } from '@truefoundry/trueforge-ui';
import { chromium, type Browser } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;

test(
  'dock panel keeps a visible edge against the chat surface in every preset and mode',
  { timeout: 180_000 },
  async () => {
    const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
    const viteCache = privateViteCache('dock-edge');
    const server = await createServer({
      cacheDir: viteCache.cacheDir,
      configFile: false,
      optimizeDeps: DEV_OPTIMIZE_DEPS,
      root: frontendRoot,
      logLevel: 'silent',
      // The dock pulls in core modules the published ui dist leaves external, so resolve them from source like the app does.
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
      const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });

      for (const preset of Object.keys(PRESETS)) {
        for (const mode of ['light', 'dark']) {
          const label = `${preset}/${mode}`;
          await page.goto(
            `http://127.0.0.1:${address.port}/tests/fixtures/dock-edge.fixture.html?preset=${preset}&mode=${mode}`,
            { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS },
          );
          const panel = page.locator('[data-aui-compact-layout]');
          await panel.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });

          const edge = await panel.evaluate(element => {
            const style = getComputedStyle(element);
            // Resolve the theme's `--border` token to the same computed color syntax as the border.
            const probe = document.createElement('span');
            probe.style.color = 'var(--border)';
            element.append(probe);
            const borderToken = getComputedStyle(probe).color;
            probe.remove();
            return {
              dataTheme: element.closest('.aui-theme-root')?.getAttribute('data-theme'),
              borderWidth: Number.parseFloat(style.borderLeftWidth),
              borderStyle: style.borderLeftStyle,
              borderColor: style.borderLeftColor,
              borderToken,
              boxShadow: style.boxShadow,
            };
          });

          assert.equal(edge.dataTheme, mode, `${label}: fixture rendered the wrong theme mode`);
          if (mode === 'dark') {
            assert.ok(edge.borderWidth > 0, `${label}: dark panel has no left border`);
            assert.notEqual(edge.borderStyle, 'none', `${label}: dark panel border is not drawn`);
            assert.equal(edge.borderColor, edge.borderToken, `${label}: dark border does not use the --border token`);
          } else {
            assert.notEqual(edge.boxShadow, 'none', `${label}: light panel has no separating shadow`);
          }
        }
      }
    } finally {
      await browser?.close();
      await server.close();
      viteCache.remove();
    }
  },
);
