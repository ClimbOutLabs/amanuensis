import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { inProcessApi, pausedSession } from './support/approvalChat.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { screenshotDir } from './support/screenshotDir.ts';

/**
 * Layout proof for a waiting approval card, against the real app and server.
 *
 * - The scroll-to-bottom arrow sits in the composer area and never covers a waiting card's
 *   buttons, at rest or scrolled up into answering position.
 * - No gradient fade over the messages above the composer washes over the card, so its
 *   buttons never look faded, as if the card were disabled.
 */

const RENDER_TIMEOUT_MS = 45_000;
const ALLOW = 'Allow';
const DENY = 'Not now';
/** How far short of the bottom the thread is scrolled: the natural answering position. */
const SCROLL_UP_PX = 110;

/** Enough finished conversation ahead of the card for the chat to scroll. */
const EARLIER_MESSAGES = Array.from(
  { length: 8 },
  (_, index) => `Harbour note ${String(index + 1)}: the ferry times are pinned by the office door.`,
);

type Box = { x: number; y: number; width: number; height: number };

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** True when the topmost element at the point is the button or something inside it. */
async function centreIsClickable(page: Page, name: string): Promise<boolean> {
  const button = page.getByRole('button', { name }).first();
  const box = await button.boundingBox();
  if (box === null) return false;
  return await button.evaluate(
    (element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return hit !== null && (hit === element || element.contains(hit));
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}

test(
  'a waiting approval card keeps its buttons clear of the scroll arrow and the fade',
  { timeout: 600_000 },
  async () => {
    const api = await startApprovalTestServer();
    const { sessionId } = await pausedSession(api, { earlierMessages: EARLIER_MESSAGES });
    const vite = await createServer({
      root: fileURLToPath(new URL('../', import.meta.url)),
      logLevel: 'error',
      plugins: [inProcessApi(api)],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    let browser: Browser | undefined;
    const outDir = await screenshotDir('aman-card-layout-');
    try {
      await vite.listen();
      const address = vite.httpServer?.address();
      if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

      await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      const allow = page.getByRole('button', { name: ALLOW }).first();
      await allow.waitFor({ timeout: RENDER_TIMEOUT_MS });
      await page.screenshot({ path: join(outDir, 'layout-1-waiting-card-at-rest.png') });

      // No gradient fade hangs over the messages above the composer.
      const fade = await page.evaluate(() => {
        const shell = document.querySelector('[data-slot="aui_thread-composer"]');
        if (shell === null) return null;
        const before = getComputedStyle(shell, '::before');
        return { content: before.content, backgroundImage: before.backgroundImage };
      });
      assert.deepEqual(
        fade,
        { content: 'none', backgroundImage: 'none' },
        'the composer puts no fade over the messages',
      );

      // Scroll up into the natural answering position: the card's buttons are on screen and
      // the thread is not at the bottom, so the scroll-to-bottom arrow is showing.
      await page.evaluate(upPx => {
        const viewport = document.querySelector('[data-slot="aui_thread-viewport"]');
        if (viewport === null) throw new Error('the thread viewport is missing');
        viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - upPx;
      }, SCROLL_UP_PX);
      const arrow = page.getByRole('button', { name: 'Scroll to bottom' }).first();
      await arrow.waitFor({ timeout: RENDER_TIMEOUT_MS });
      const deny = page.getByRole('button', { name: DENY }).first();
      await deny.waitFor({ timeout: RENDER_TIMEOUT_MS });
      await page.screenshot({ path: join(outDir, 'layout-2-scrolled-up-arrow-clear-of-the-card.png') });

      const arrowBox = await arrow.boundingBox();
      const allowBox = await allow.boundingBox();
      const denyBox = await deny.boundingBox();
      const composerBox = await page.locator('[data-slot="aui_thread-composer"]').boundingBox();
      if (arrowBox === null || allowBox === null || denyBox === null || composerBox === null) {
        throw new Error('a layout box was missing');
      }
      assert.equal(boxesOverlap(arrowBox, allowBox), false, 'the arrow does not cover Allow');
      assert.equal(boxesOverlap(arrowBox, denyBox), false, 'the arrow does not cover Not now');
      assert.ok(arrowBox.y >= composerBox.y, 'the arrow sits in the composer area, below the message list');
      assert.equal(await centreIsClickable(page, ALLOW), true, 'the centre of Allow takes the click');
      assert.equal(await centreIsClickable(page, DENY), true, 'the centre of Not now takes the click');

      assert.equal(api.mcp.writeInvocations(), 0, 'looking at the card ran nothing');
      console.log(`approval-card layout screenshots written to ${outDir}`);
    } finally {
      await browser?.close();
      await vite.close();
      await api.close();
    }
  },
);
