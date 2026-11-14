import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1100, height: 900 };
const CARDS = ['search', 'calendar', 'email', 'email-new-recipient', 'command', 'held', 'skill-network'] as const;

/**
 * The one fixed slot of every choice a card can show, from left to right. A card shows only some of them,
 * but the ones it shows always keep this order, so each choice sits in the same place on every card.
 */
const SLOTS: readonly (readonly string[])[] = [
  ['Allow', 'Add and send', 'Add and save draft'],
  ['Always allow in this chat'],
  ['Always allow everywhere', 'Always allow for this skill'],
  ['Allow all', 'Allow all (3)'],
  ['Change it'],
  ['Save as draft'],
  ['Not now', 'Deny', 'Keep it', "Don't send", "Don't save"],
];

function slotOf(label: string): number {
  return SLOTS.findIndex(names => names.includes(label));
}

type Choice = { label: string; left: number; background: string; color: string };

async function rows(page: Page): Promise<Map<string, Choice[]>> {
  const found = new Map<string, Choice[]>();
  for (const name of CARDS) {
    const choices = await page.locator(`[data-row-card="${name}"]`).evaluate(root => {
      const card = root.querySelector('.aui-approval-card');
      const actions = root.querySelector('.aui-approval-card__actions');
      if (card === null || actions === null) throw new Error('the card has no choice row');
      const cardLeft = card.getBoundingClientRect().left;
      // A closed confirm step keeps its buttons in the page, unseen, so only the buttons a person can see count.
      return Array.from(actions.querySelectorAll('button'))
        .filter(button => button.checkVisibility())
        .map(button => {
          const style = getComputedStyle(button);
          return {
            label: (button.textContent ?? '').trim(),
            left: Math.round(button.getBoundingClientRect().left - cardLeft),
            background: style.backgroundColor,
            color: style.color,
          };
        });
    });
    found.set(name, choices);
  }
  return found;
}

async function checkRows(page: Page, where: string): Promise<void> {
  const found = await rows(page);
  const firstLeft = found.get('search')?.[0]?.left;
  const firstLook = found.get('search')?.[0];
  assert.ok(firstLeft !== undefined && firstLook !== undefined, `${where}: the search card has no choices`);
  for (const [name, choices] of found) {
    const labels = choices.map(choice => choice.label).join(', ');
    const slots = choices.map(choice => slotOf(choice.label));
    assert.ok(!slots.includes(-1), `${where}: ${name} shows a choice with no fixed place: ${labels}`);
    assert.equal(slots[0], 0, `${where}: ${name} does not start with the yes: ${labels}`);
    assert.equal(slots.at(-1), SLOTS.length - 1, `${where}: ${name} does not end with the no: ${labels}`);
    for (let index = 1; index < slots.length; index += 1) {
      assert.ok(
        (slots[index] ?? 0) > (slots[index - 1] ?? 0),
        `${where}: ${name} has its choices out of order: ${labels}`,
      );
    }
    // The yes sits at the same spot on every card, and every choice has the same plain look.
    assert.equal(choices[0]?.left, firstLeft, `${where}: ${name} starts its row somewhere else`);
    for (const choice of choices) {
      assert.equal(choice.background, firstLook.background, `${where}: ${name} "${choice.label}" is filled`);
      assert.equal(choice.color, firstLook.color, `${where}: ${name} "${choice.label}" has its own ink`);
    }
  }
}

test('every approval card kind puts each choice in the same place', { timeout: 180_000 }, async () => {
  const viteCache = privateViteCache('approval-card-row');
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
    for (const [where, viewport] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const page = await browser.newPage({ viewport, isMobile: where === 'phone', hasTouch: where === 'phone' });
      await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/approval-card-row.fixture.html`, {
        waitUntil: 'domcontentloaded',
        timeout: FIRST_LOAD_TIMEOUT_MS,
      });
      await page
        .locator('[data-row-card="held"] .aui-approval-card__actions button')
        .first()
        .waitFor({ timeout: RENDER_TIMEOUT_MS });
      await checkRows(page, where);
      await page.screenshot({
        path: await featureShotPath({ surface: 'screen:approval-card', step: `choice-row-${where}` }),
        fullPage: true,
      });
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
});
