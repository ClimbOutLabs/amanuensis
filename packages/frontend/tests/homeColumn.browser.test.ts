import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { screenshotDir } from './support/screenshotDir.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
/** The first page waits for the dev server's cold compile, which is slow while other suites run. */
const FIRST_LOAD_TIMEOUT_MS = 120_000;
const VIEWPORTS = [
  { width: 1440, height: 900, label: 'desktop' },
  { width: 390, height: 844, label: 'phone' },
] as const;

/** The left and right edges of each home block, with text measured where its glyphs start. */
async function homeEdges(page: Page) {
  await page.getByRole('heading', { name: /Some things .* can do/ }).waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
  await page.waitForTimeout(500);
  // No named helpers inside evaluate: tsx would wrap them in a helper the page does not have.
  return page.evaluate(() => {
    const range = document.createRange();
    const lefts = ['.aman-home-greeting', '#aman-home-cards-heading'].map(selector => {
      const el = document.querySelector(selector);
      if (el === null) throw new Error(`${selector} is missing`);
      range.selectNodeContents(el);
      return range.getBoundingClientRect().left;
    });
    const boxes = [
      '[data-slot="aui_composer-shell"]',
      'ul[aria-label="What would help you most?"] li button',
      '[aria-labelledby="aman-home-cards-heading"] li button',
    ].map(selector => {
      const el = document.querySelector(selector);
      if (el === null) throw new Error(`${selector} is missing`);
      return el.getBoundingClientRect();
    });
    const cards = Array.from(document.querySelectorAll('[aria-labelledby="aman-home-cards-heading"] li button'));
    const second = cards[1];
    if (second === undefined) throw new Error('home shows fewer than two cards');
    return {
      greeting: lefts[0] ?? Number.NaN,
      label: lefts[1] ?? Number.NaN,
      composerLeft: boxes[0]?.left ?? Number.NaN,
      composerRight: boxes[0]?.right ?? Number.NaN,
      pill: boxes[1]?.left ?? Number.NaN,
      card: boxes[2]?.left ?? Number.NaN,
      secondCardRight: second.getBoundingClientRect().right,
      truncated: cards.filter(card => {
        const detail = card.lastElementChild;
        return detail !== null && detail.scrollHeight > detail.clientHeight + 1;
      }).length,
    };
  });
}

/** The titles of the cards whose description is cut off, with the default set and then each pill chosen in turn. */
async function cutOffCards(page: Page): Promise<string[]> {
  const pills = page.getByRole('list', { name: 'What would help you most?' }).getByRole('button');
  const cutOff: string[] = [];
  for (let index = -1; index < (await pills.count()); index += 1) {
    if (index >= 0) await pills.nth(index).click();
    await page.waitForTimeout(100);
    cutOff.push(
      ...(await page.evaluate(() =>
        Array.from(document.querySelectorAll('[aria-labelledby="aman-home-cards-heading"] li button'))
          .filter(card => {
            const detail = card.lastElementChild;
            return detail !== null && detail.scrollHeight > detail.clientHeight + 1;
          })
          .map(card => card.textContent ?? ''),
      )),
    );
    if (index >= 0) await pills.nth(index).click();
  }
  return cutOff;
}

test('home is one left-aligned column whose edges the composer and the cards share', { timeout: 600_000 }, async () => {
  const api = await startApprovalTestServer();
  const viteCache = privateViteCache('home-column');
  const vite = await createServer({
    cacheDir: viteCache.cacheDir,
    root: fileURLToPath(new URL('../', import.meta.url)),
    logLevel: 'error',
    plugins: [inProcessApi(api)],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  let browser: Browser | undefined;
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
    const shots = await screenshotDir('aman-home-column-');

    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      await context.addInitScript(() => {
        localStorage.setItem('aui-theme-preference', 'light');
      });
      const page = await context.newPage();
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      const edges = await homeEdges(page);
      const label = viewport.label;
      for (const [name, left] of Object.entries({
        composer: edges.composerLeft,
        'first pill': edges.pill,
        'section label': edges.label,
        'first card': edges.card,
      })) {
        assert.ok(Math.abs(left - edges.greeting) <= 1, `${label}: ${name} starts at the greeting's edge`);
      }
      assert.ok(
        Math.abs(edges.secondCardRight - edges.composerRight) <= 1,
        `${label}: the second card ends where the composer ends`,
      );
      assert.deepEqual(await cutOffCards(page), [], `${label}: no description is cut off under any pill`);
      assert.equal(edges.truncated, 0, `${label}: no card description is cut off`);
      console.log(`${label} edges: ${JSON.stringify(edges)}`);
      await page.screenshot({ path: join(shots, `home-${viewport.width}x${viewport.height}-light.png`) });
      await context.close();
    }
    console.log(`screenshots: ${shots}`);
  } finally {
    await browser?.close();
    await vite.close();
    viteCache.remove();
    await api.close();
  }
});
