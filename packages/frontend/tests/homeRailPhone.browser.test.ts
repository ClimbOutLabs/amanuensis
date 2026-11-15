import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Locator } from 'playwright-core';
import { createServer } from 'vite';

import { MODEL_FQN, startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { inProcessApi, pausedSession } from './support/approvalChat.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const SURFACE = 'screen:home';
const REMINDER = 'Call the dentist about Friday';
/** Far enough ahead that it cannot go off during the test. */
const REMINDER_AHEAD_MS = 10 * 60_000;

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** A time zone where the reminder still falls on today, whatever hour the test runs at. */
function zoneWhereTodayHolds(at: Date): string {
  for (const zone of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: zone }).format(at),
    );
    if (hour >= 1 && hour <= 22) return zone;
  }
  return 'UTC';
}

/** Whether a row sits fully inside the window once scrolled to, so a thumb can reach it. */
async function onScreen(row: Locator): Promise<boolean> {
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  const view = row.page().viewportSize();
  if (box === null || view === null) return false;
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width && box.y + box.height <= view.height;
}

test('on a phone the open panel lists what is due and what needs your OK', { timeout: 300_000 }, async () => {
  const api = await startApprovalTestServer();
  const viteCache = privateViteCache('home-rail-phone');
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

    await pausedSession(api);
    const agent = await api.request(
      '/api/v1/agents',
      jsonInit({
        name: 'aman',
        description: 'The assistant',
        manifest: { model: { name: MODEL_FQN }, instructions: 'Help.' },
      }),
    );
    assert.equal(agent.status, 201, 'the agent was saved');
    const due = new Date(Date.now() + REMINDER_AHEAD_MS);
    const timezoneId = zoneWhereTodayHolds(due);
    const reminder = await api.request(
      '/api/v1/schedules',
      jsonInit({
        agent_name: 'aman',
        name: 'reminder-1',
        manifest: { task: REMINDER, run_at: due.toISOString(), timezone: timezoneId, kind: 'reminder' },
      }),
    );
    assert.equal(reminder.status, 201, 'the reminder was set');

    browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      timezoneId,
    });
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
    const panel = page.getByRole('complementary', { name: 'Amanuensis runtime status' });
    await panel.waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });

    const dueList = panel.getByRole('region', { name: 'Due' });
    const needsOk = panel.getByRole('region', { name: 'Needs your OK' });
    await dueList.waitFor({ state: 'visible', timeout: FIRST_LOAD_TIMEOUT_MS });
    await needsOk.waitFor({ state: 'visible', timeout: FIRST_LOAD_TIMEOUT_MS });
    await page.screenshot({ path: await featureShotPath({ surface: SURFACE, step: 'phone-panel-lists' }) });

    assert.ok(await onScreen(dueList.getByText(REMINDER)), 'the due reminder can be reached on a phone');
    const waitingRow = needsOk.getByRole('button').first();
    assert.ok(await onScreen(waitingRow), 'what needs your OK can be reached on a phone');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 1, `nothing runs off the side (${String(wide)}px over)`);

    // Hidden, the strip goes back to the picture alone and the lists leave the chat its room.
    await panel.getByRole('button', { name: 'Hide panel' }).click();
    await page.getByRole('button', { name: 'Show panel' }).waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
    assert.equal(await panel.getByRole('region', { name: 'Due' }).count(), 0, 'the hidden panel lists nothing');
    await page.getByRole('button', { name: 'Show panel' }).click();

    // A row on the phone strip still opens the chat that waits.
    await panel.getByRole('region', { name: 'Needs your OK' }).getByRole('button').first().click();
    await page.waitForURL(/\/sessions\//, { timeout: FIRST_LOAD_TIMEOUT_MS });
    await context.close();
  } catch (error) {
    await saveFailureShots({ browser, surface: SURFACE });
    throw error;
  } finally {
    await browser?.close();
    await vite.close();
    viteCache.remove();
    await api.close();
  }
});
