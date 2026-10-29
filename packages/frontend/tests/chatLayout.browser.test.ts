import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { FINAL_TEXT } from '../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;

type ColumnBox = { width: number; leftGap: number; rightGap: number; transition: string };

/** The composer's width and its gaps to the chat column's edges, once any widening has settled. */
async function composerBox(page: Page): Promise<ColumnBox> {
  const read = () =>
    page.evaluate(() => {
      const composer = document.querySelector('.aui-thread-composer');
      const column = composer?.parentElement;
      if (composer == null || column == null) throw new Error('no composer on screen');
      const inner = composer.getBoundingClientRect();
      const outer = column.getBoundingClientRect();
      return {
        width: inner.width,
        leftGap: inner.left - outer.left,
        rightGap: outer.right - inner.right,
        transition: getComputedStyle(composer).transitionDuration,
      };
    });
  let previous = await read();
  for (;;) {
    await page.waitForTimeout(150);
    const next = await read();
    if (Math.abs(next.width - previous.width) < 0.5) return next;
    previous = next;
  }
}

function assertCentred(box: ColumnBox, label: string): void {
  assert.ok(Math.abs(box.leftGap - box.rightGap) <= 1, `${label}: the chat stays centred (${JSON.stringify(box)})`);
}

test(
  'the chat widens when side panels fold, and its phone header keeps to one line',
  { timeout: 300_000 },
  async () => {
    const api = await startApprovalTestServer();
    const viteCache = privateViteCache('chat-layout');
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

      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      await page.getByRole('complementary', { name: 'Recent chats' }).waitFor({ timeout: RENDER_TIMEOUT_MS });
      const composer = page.getByRole('textbox').first();
      await composer.waitFor({ timeout: RENDER_TIMEOUT_MS });
      await composer.fill('Hello');
      await composer.press('Enter');
      await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      await page.locator('.aui-thread-composer').waitFor({ timeout: RENDER_TIMEOUT_MS });

      const bothOpen = await composerBox(page);
      assertCentred(bothOpen, 'both sides open');
      assert.equal(bothOpen.transition, '0.3s', 'the width change is smooth when motion is allowed');

      await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: 'Chats' }).click();
      await page.getByRole('complementary', { name: 'Recent chats' }).waitFor({ state: 'detached' });
      const listFolded = await composerBox(page);
      assert.ok(listFolded.width > bothOpen.width + 64, `folding the chat list widens the chat (${listFolded.width})`);
      assertCentred(listFolded, 'chat list folded');

      await page.getByRole('button', { name: 'Hide panel' }).click();
      const bothFolded = await composerBox(page);
      assert.ok(
        bothFolded.width > listFolded.width + 64,
        `folding the right panel widens it more (${bothFolded.width})`,
      );
      assertCentred(bothFolded, 'both sides folded');

      await page.getByRole('button', { name: 'Show panel' }).click();
      const panelBack = await composerBox(page);
      assert.ok(Math.abs(panelBack.width - listFolded.width) <= 1, 'showing the panel again narrows the chat back');
      const chatUrl = page.url();
      await context.close();

      const reduced = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      const still = await reduced.newPage();
      await still.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      await still.locator('.aui-thread-composer').waitFor({ timeout: RENDER_TIMEOUT_MS });
      assert.equal((await composerBox(still)).transition, '0s', 'with reduced motion the width changes at once');
      await reduced.close();

      // On a phone the chat header keeps the menu button, the title and every action on one line.
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const small = await phone.newPage();
      await small.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      await small.getByRole('switch', { name: 'Agent details' }).waitFor({ timeout: RENDER_TIMEOUT_MS });
      const header = await small.evaluate(() => {
        const bar = document.querySelector('header');
        if (bar == null) throw new Error('no header');
        const box = bar.getBoundingClientRect();
        const controls = Array.from(bar.querySelectorAll('button')).map(button => button.getBoundingClientRect());
        return {
          height: box.height,
          overflows: bar.scrollWidth > bar.clientWidth + 1,
          tops: controls.map(rect => Math.round(rect.top + rect.height / 2)),
          rightmost: Math.max(...controls.map(rect => rect.right)),
          width: window.innerWidth,
        };
      });
      assert.ok(!header.overflows, 'the phone header does not overflow');
      assert.ok(header.height <= 57, `the phone header is one line tall (${header.height})`);
      assert.ok(header.rightmost <= header.width, 'every header action is on screen');
      assert.equal(new Set(header.tops).size, 1, `every header control sits on one row (${header.tops.join(', ')})`);
      await phone.close();
    } finally {
      await browser?.close();
      await vite.close();
      viteCache.remove();
      await api.close();
    }
  },
);
