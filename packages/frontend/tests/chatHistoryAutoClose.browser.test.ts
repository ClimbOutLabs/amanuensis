import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const HIDE = 'Hide recent chats';
const SHOW = 'Show recent chats';
const KEEP_OPEN = 'Keep chat history open';
const LET_CLOSE = 'Let chat history close';
/** A point in the conversation area, clear of the history panel and the header. */
const CONVERSATION_POINT = { x: 900, y: 300 };

async function withFixturePage(
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const server = await createServer({
    configFile: false,
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

    browser = await chromium.launch({
      executablePath: findChromiumExecutable(chromium.executablePath()),
      headless: true,
    });
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/chat-history.fixture.html`, {
      waitUntil: 'domcontentloaded',
      timeout: RENDER_TIMEOUT_MS,
    });
    await run(page);
  } finally {
    await browser?.close();
    await server.close();
  }
}

const historyPanel = (page: Page) => page.getByRole('complementary', { name: 'Recent chats' });

/** Lets a close transition (200ms) finish, then reads the panel's visible state. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(400);
}

test(
  'desktop 1440x900: the panel closes on a conversation press, stays open when pinned, and Escape returns focus',
  { timeout: 180_000 },
  async () => {
    await withFixturePage(DESKTOP, async page => {
      await page.getByRole('button', { name: HIDE }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
      const panelBox = await historyPanel(page).boundingBox();
      assert.ok(panelBox != null, 'The recent-chats panel should show at desktop width');
      assert.ok(
        panelBox.width >= 250 && panelBox.width <= 262,
        `Panel is ${panelBox.width}px wide, expected about 256px`,
      );

      // Pointer over the panel, then a press in the conversation: the panel closes.
      await historyPanel(page).hover();
      await page.mouse.click(CONVERSATION_POINT.x, CONVERSATION_POINT.y);
      await page.getByRole('button', { name: SHOW }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
      await settle(page);
      assert.equal(
        await historyPanel(page).isVisible(),
        false,
        'The panel should be closed after a conversation press',
      );

      await page.getByRole('button', { name: SHOW }).click();
      await page.getByRole('button', { name: HIDE }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });

      // Pinned: the same press keeps the panel open, and the pin is remembered across a reload.
      await page.getByRole('button', { name: KEEP_OPEN }).click();
      await page.mouse.click(CONVERSATION_POINT.x, CONVERSATION_POINT.y);
      await settle(page);
      assert.equal(await page.getByRole('button', { name: HIDE }).count(), 1, 'A pinned panel should stay open');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: LET_CLOSE }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
      await page.getByRole('button', { name: LET_CLOSE }).click();
      await page.getByRole('button', { name: KEEP_OPEN }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });

      // Escape closes the panel and gives focus back to the Hide recent chats button.
      await page.getByRole('button', { name: KEEP_OPEN }).focus();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: SHOW }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
      const focusedLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
      assert.equal(focusedLabel, SHOW, 'Escape should return focus to the button that opened the panel');
    });
  },
);

test(
  'phone 390x844: the history panel is an overlay with no pin, and it closes from the backdrop',
  { timeout: 180_000 },
  async () => {
    await withFixturePage(PHONE, async page => {
      await page.getByRole('button', { name: 'Navigation' }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
      assert.equal(await historyPanel(page).isVisible(), false, 'The desktop panel should be hidden on a phone');

      await page.getByRole('button', { name: 'Navigation' }).click();
      const overlay = page.getByRole('dialog', { name: 'Navigation' });
      await overlay.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
      assert.equal(await overlay.getByRole('button', { name: KEEP_OPEN }).count(), 0, 'The phone overlay has no pin');

      // The overlay covers the left edge of the backdrop, so press the backdrop to its right.
      await page.getByRole('button', { name: 'Close navigation' }).click({ position: { x: PHONE.width - 24, y: 400 } });
      await overlay.waitFor({ state: 'detached', timeout: RENDER_TIMEOUT_MS });
    });
  },
);

/** Panel and toggle must agree: Show means no visible panel, Hide means a full-width panel. */
async function assertToggleMatchesPanel(page: Page, message: string): Promise<void> {
  const showing = (await page.getByRole('button', { name: HIDE }).count()) === 1;
  const panelBox = await historyPanel(page).boundingBox();
  if (showing) {
    assert.ok(
      panelBox != null && panelBox.width >= 250,
      `${message}: Hide is shown but the panel is ${panelBox?.width}px`,
    );
  } else {
    assert.ok(panelBox == null || panelBox.width < 1, `${message}: Show is shown but the panel is open`);
  }
}

test(
  'a composer focus at phone width does not leave the panel stuck when the window widens',
  { timeout: 180_000 },
  async () => {
    await withFixturePage(PHONE, async page => {
      await page.getByRole('button', { name: 'Navigation' }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
      await page.locator('[data-slot="aui_composer-root"] textarea').first().focus();
      await settle(page);

      await page.setViewportSize(DESKTOP);
      await settle(page);
      await assertToggleMatchesPanel(page, 'after a composer focus at phone width');
    });
  },
);

test('Escape at phone width does not leave the panel stuck when the window widens', { timeout: 180_000 }, async () => {
  await withFixturePage(PHONE, async page => {
    await page.getByRole('button', { name: 'Navigation' }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
    await page.keyboard.press('Escape');
    await settle(page);

    await page.setViewportSize(DESKTOP);
    await page.getByRole('button', { name: HIDE }).waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });
    await settle(page);
    const panelBox = await historyPanel(page).boundingBox();
    assert.ok(
      panelBox != null && panelBox.width >= 250,
      `The panel is ${panelBox?.width}px after Escape at phone width`,
    );
  });
});
