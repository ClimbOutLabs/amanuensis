import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
const KINDS = ['email', 'calendar', 'shell', 'space', 'connector'] as const;

test(
  'every approval card is set in the body font, with only the question and a mail body at the chat body size',
  { timeout: 180_000 },
  async () => {
    const viteCache = privateViteCache('approval-card-type');
    const server = await createServer({
      cacheDir: viteCache.cacheDir,
      configFile: false,
      optimizeDeps: DEV_OPTIMIZE_DEPS,
      root: fileURLToPath(new URL('../', import.meta.url)),
      logLevel: 'silent',
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
      for (const theme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/approval-cards.fixture.html?theme=${theme}`, {
          waitUntil: 'domcontentloaded',
          timeout: FIRST_LOAD_TIMEOUT_MS,
        });
        await page.locator('[data-card="connector"] h3').waitFor({ timeout: RENDER_TIMEOUT_MS });
        await page.screenshot({
          path: await featureShotPath({ surface: 'screen:approval-card', step: `every-kind-${theme}` }),
          fullPage: true,
        });

        const chat = await page.locator('[data-role="chat-line"]').evaluate(el => {
          const style = getComputedStyle(el);
          const theme = el.closest('.aui-theme-root');
          if (theme === null) throw new Error('the chat is outside the theme root');
          // The steps are rem values; the root size turns them into the px a computed style reports.
          const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
          const themeStyle = getComputedStyle(theme);
          return {
            family: style.fontFamily,
            size: style.fontSize,
            xs: Number.parseFloat(themeStyle.getPropertyValue('--text-xs')) * rootPx,
            sm: Number.parseFloat(themeStyle.getPropertyValue('--text-sm')) * rootPx,
          };
        });
        const chatPx = Number.parseFloat(chat.size);
        assert.ok(chat.xs > 0 && chat.sm > chat.xs && chatPx > chat.sm, `the theme type steps are set (${theme})`);

        for (const kind of KINDS) {
          const card = await page.locator(`[data-card="${kind}"]`).evaluate(root => {
            const title = root.querySelector('h3');
            if (title === null) throw new Error('the card has no title');
            const titleStyle = getComputedStyle(title);
            const texts = Array.from(root.querySelectorAll('*')).filter(
              el =>
                !(el instanceof HTMLButtonElement) &&
                el.closest('button') === null &&
                Array.from(el.childNodes).some(
                  node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
                ),
            );
            return {
              title: {
                size: Number.parseFloat(titleStyle.fontSize),
                weight: titleStyle.fontWeight,
                family: titleStyle.fontFamily,
              },
              text: texts
                .filter(el => el !== title)
                .map(el => {
                  const style = getComputedStyle(el);
                  return {
                    text: (el.textContent ?? '').trim().slice(0, 40),
                    size: Number.parseFloat(style.fontSize),
                    family: style.fontFamily,
                    ownFont: el.closest('.font-mono') !== null,
                    mailBody: el.closest('section[aria-label="Message body"]') !== null,
                    quiet: el.closest('[data-role="approval-status"], [data-role="approval-reason"], dt') !== null,
                    transform: style.textTransform,
                  };
                }),
            };
          });

          assert.equal(`${card.title.size}px`, chat.size, `${kind} (${theme}): title is the chat's body size`);
          assert.equal(card.title.weight, '600', `${kind} (${theme}): title is semibold`);
          assert.equal(card.title.family, chat.family, `${kind} (${theme}): title uses the body font`);
          for (const line of card.text) {
            if (line.ownFont) continue;
            const where = `${kind} (${theme}): "${line.text}"`;
            assert.equal(line.family, chat.family, `${where} uses the body font`);
            assert.equal(line.transform, 'none', `${where} is not set in capitals`);
            assert.ok(line.size >= chat.xs, `${where} is no smaller than the smallest type step`);
            if (line.mailBody) {
              assert.equal(`${line.size}px`, chat.size, `${where} is a mail body at the chat's body size`);
            } else if (line.quiet) {
              assert.ok(line.size <= chat.sm, `${where} is a quiet line, smaller than the chat's body size`);
            } else {
              assert.ok(line.size < chatPx, `${where} sits below the question, smaller than the chat's body size`);
            }
          }
        }
        await page.close();
      }
    } catch (error) {
      await saveFailureShots({ browser, surface: 'screen:approval-card' });
      throw error;
    } finally {
      await browser?.close();
      await server.close();
      viteCache.remove();
    }
  },
);
