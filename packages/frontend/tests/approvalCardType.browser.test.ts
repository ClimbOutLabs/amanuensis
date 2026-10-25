import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;
const KINDS = ['email', 'calendar', 'shell', 'space', 'connector'] as const;
/** 1.125rem at 1rem = 16px. */
const TITLE_MAX_PX = 18;

test(
  'every approval card is set in the body font, with a title no larger than 1.125rem',
  { timeout: 180_000 },
  async () => {
    const server = await createServer({
      configFile: false,
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
      browser = await chromium.launch({ executablePath: findChromiumExecutable(), headless: true });
      for (const theme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/approval-cards.fixture.html?theme=${theme}`, {
          waitUntil: 'domcontentloaded',
          timeout: RENDER_TIMEOUT_MS,
        });
        await page.locator('[data-card="connector"] h3').waitFor({ timeout: RENDER_TIMEOUT_MS });

        const chat = await page.locator('[data-role="chat-line"]').evaluate(el => {
          const style = getComputedStyle(el);
          return { family: style.fontFamily, size: style.fontSize };
        });

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
                    transform: style.textTransform,
                  };
                }),
            };
          });

          assert.ok(card.title.size <= TITLE_MAX_PX, `${kind} (${theme}): title is ${card.title.size}px`);
          assert.equal(card.title.weight, '600', `${kind} (${theme}): title is semibold`);
          assert.equal(card.title.family, chat.family, `${kind} (${theme}): title uses the body font`);
          for (const line of card.text) {
            if (line.ownFont) continue;
            assert.equal(line.family, chat.family, `${kind} (${theme}): "${line.text}" uses the body font`);
            assert.equal(`${line.size}px`, chat.size, `${kind} (${theme}): "${line.text}" is the chat's body size`);
            assert.equal(line.transform, 'none', `${kind} (${theme}): "${line.text}" is not set in capitals`);
          }
        }
        await page.close();
      }
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
