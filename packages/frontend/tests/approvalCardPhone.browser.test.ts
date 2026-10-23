import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;
const PHONE = { width: 390, height: 844 };

async function screenshotDir(): Promise<string> {
  const configured = process.env.AMAN_SCREENSHOT_DIR;
  if (configured != null && configured !== '') {
    await mkdir(configured, { recursive: true });
    return configured;
  }
  return await mkdtemp(join(tmpdir(), 'aman-approval-phone-'));
}

test('both approval cards fit a 390 px phone with every choice in reach', { timeout: 180_000 }, async () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const server = await createServer({
    configFile: false,
    root: frontendRoot,
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
    const page = await browser.newPage({ viewport: PHONE, isMobile: true, hasTouch: true });
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/approval-card-phone.fixture.html`, {
      waitUntil: 'domcontentloaded',
      timeout: RENDER_TIMEOUT_MS,
    });

    const ticket = page.getByTestId('ticket-card');
    const plain = page.getByTestId('plain-card');
    const ticketChoices = ['Allow it', 'Not now', 'Allow searches in this chat'];
    const plainChoices = ['Allow it', 'Not now', 'Approve for this chat'];
    await ticket
      .getByRole('button', { name: ticketChoices[0] })
      .waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });

    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(pageWidth <= PHONE.width, `the page scrolls sideways: ${String(pageWidth)} px wide`);

    // Every choice shows without opening Details, and sits fully inside the screen.
    for (const [card, names] of [
      [ticket, ticketChoices],
      [plain, plainChoices],
    ] as const) {
      for (const name of names) {
        const choice = card.getByRole('button', { name, exact: true });
        assert.equal(await choice.isVisible(), true, `${name} is not visible`);
        const box = await choice.boundingBox();
        assert.ok(box !== null, `${name} has no box`);
        assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, `${name} runs off the screen`);
      }
    }

    // The generic ticket shows who a draft goes to without opening Details.
    const recipient = plain.getByText(/to: robin@example\.test/);
    assert.equal(await recipient.isVisible(), true, 'the recipient is not visible');
    const recipientBox = await recipient.boundingBox();
    assert.ok(recipientBox !== null, 'the recipient has no box');
    assert.ok(
      recipientBox.x >= 0 && recipientBox.x + recipientBox.width <= PHONE.width,
      'the recipient runs off the screen',
    );

    const dir = await screenshotDir();
    await ticket.screenshot({ path: join(dir, 'approval-ticket-390.png') });
    await plain.screenshot({ path: join(dir, 'approval-plain-390.png') });
  } finally {
    await browser?.close();
    await server.close();
  }
});
