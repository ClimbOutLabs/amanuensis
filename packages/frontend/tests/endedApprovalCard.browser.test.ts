import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { newEventId } from '@truefoundry/trueforge-core/core/events/schema';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { startApprovalTestServer, type ApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { inProcessApi, pausedSession, waitingCallIds } from './support/approvalChat.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { screenshotDir } from './support/screenshotDir.ts';

const RENDER_TIMEOUT_MS = 45_000;
const ENDED_NOTE = 'This request ended. Ask again if you still need it.';
const ALLOW = 'Allow';
const DENY = 'Not now';

/**
 * The chat moved on: a newer turn runs and finishes, so the paused turn's request has ended. It is
 * stored the way a run stores it: created running, then finished with its turn.done event.
 */
async function endRequest(api: ApprovalTestServer, ids: { sessionId: string; pausedTurnId: string }): Promise<void> {
  const now = new Date();
  const turnId = `${ids.pausedTurnId}-next`;
  const store = api.sessionStore();
  await store.createTurn({
    turn: {
      turn_id: turnId,
      session_id: ids.sessionId,
      first_turn_id: ids.pausedTurnId,
      ancestor_ids: [ids.pausedTurnId],
      previous_turn_id: ids.pausedTurnId,
      state: { status: 'running' },
      input: [],
      created_at: now,
      updated_at: now,
      custom: null,
    },
    approval_grants: [],
    require_previous_turn_is_tip: false,
    retained_previous_thread_ids: ['main'],
    new_threads: [],
    new_context_appends: [],
    capability_states: [{ thread_id: 'main', capability_state: null }],
    tool_call_memos: [],
    task_states: [],
    sandbox_info: null,
    update_session_title_if_not_exist: null,
  });
  const done = { status: 'done' as const, output: null, required_actions: [], completed_at: new Date().toISOString() };
  await store.updateTurnState({
    session_id: ids.sessionId,
    turn_id: turnId,
    state: done,
    turn_done_event: {
      type: 'turn.done',
      id: newEventId(),
      state: done,
      created_at: done.completed_at,
      thread_id: null,
    },
  });
}

async function openChat(page: Page, origin: string, sessionId: string): Promise<void> {
  await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
  await page.getByText('run:inert_write please').first().waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/**
 * Clicks a card button the chat may be replacing at that moment: the open chat can learn the
 * request ended and swap the card for the ended note first. Returns false when that happened.
 */
async function clickUnlessEnded(page: Page, name: string): Promise<boolean> {
  try {
    await page.getByRole('button', { name }).first().click({ timeout: 10_000 });
    return true;
  } catch (error) {
    if (await page.getByText(ENDED_NOTE).isVisible()) return false;
    throw error;
  }
}

/** After a reload the card must not be shown as waiting: no Allow, no Not now. */
async function assertNotWaitingAfterReload(page: Page, name: string): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('run:inert_write please').first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  await page.waitForTimeout(3_000);
  assert.equal(await page.getByRole('button', { name: ALLOW }).count(), 0, `${name}: no Allow after reload`);
  assert.equal(await page.getByRole('button', { name: DENY }).count(), 0, `${name}: no Not now after reload`);
}

test('an ended approval card can be cleared but never run', { timeout: 600_000 }, async () => {
  const api = await startApprovalTestServer();
  const vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    logLevel: 'error',
    plugins: [inProcessApi(api)],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  let browser: Browser | undefined;
  const outDir = await screenshotDir('aman-ended-card-');
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    await test.test('Dismiss on a card that had already ended', async () => {
      const ids = await pausedSession(api);
      await endRequest(api, ids);
      const page = await context.newPage();
      await openChat(page, origin, ids.sessionId);
      await page.waitForTimeout(5_000);
      await page.screenshot({ path: join(outDir, 'ended-0-opened.png'), fullPage: true });
      await page.getByText(ENDED_NOTE).waitFor({ timeout: RENDER_TIMEOUT_MS });
      assert.equal(await page.getByRole('button', { name: ALLOW }).count(), 0, 'an ended card offers no Allow');
      await page.screenshot({ path: join(outDir, 'ended-1-before-dismiss.png'), fullPage: true });

      await page.getByRole('button', { name: 'Dismiss' }).click();
      await page.getByText(ENDED_NOTE).waitFor({ state: 'detached', timeout: RENDER_TIMEOUT_MS });
      await page.screenshot({ path: join(outDir, 'ended-2-after-dismiss.png'), fullPage: true });
      await assertNotWaitingAfterReload(page, 'dismiss');
      assert.equal(await page.getByText(ENDED_NOTE).count(), 0, 'the dismissed card stays cleared');
      await page.screenshot({ path: join(outDir, 'ended-3-dismiss-reloaded.png'), fullPage: true });
      assert.equal(api.mcp.writeInvocations(), 0, 'Dismiss runs nothing');
      await page.close();
    });

    await test.test('Allow on a card that ended while the chat was open', async () => {
      const ids = await pausedSession(api);
      const page = await context.newPage();
      await openChat(page, origin, ids.sessionId);
      const allow = page.getByRole('button', { name: ALLOW }).first();
      await allow.waitFor({ timeout: RENDER_TIMEOUT_MS });
      await endRequest(api, ids);

      // Either the click reached the server and was refused, or the chat had already ended the card.
      if (await clickUnlessEnded(page, ALLOW)) {
        await page.getByText(ENDED_NOTE).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      }
      await page.screenshot({ path: join(outDir, 'ended-4-allow-refused.png'), fullPage: true });
      assert.equal(api.mcp.writeInvocations(), 0, 'Allow on an ended request runs nothing');
      await assertNotWaitingAfterReload(page, 'allow');
      await page.getByText(ENDED_NOTE).waitFor({ timeout: RENDER_TIMEOUT_MS });
      await page.screenshot({ path: join(outDir, 'ended-5-allow-reloaded.png'), fullPage: true });
      assert.equal(api.mcp.writeInvocations(), 0, 'still nothing ran');
      await page.close();
    });

    await test.test('Not now on a card that ended while the chat was open', async () => {
      const ids = await pausedSession(api);
      const page = await context.newPage();
      await openChat(page, origin, ids.sessionId);
      const deny = page.getByRole('button', { name: DENY }).first();
      await deny.waitFor({ timeout: RENDER_TIMEOUT_MS });
      await endRequest(api, ids);

      await clickUnlessEnded(page, DENY);
      await page.waitForTimeout(3_000);
      await page.screenshot({ path: join(outDir, 'ended-6-deny-clicked.png'), fullPage: true });
      assert.equal(api.mcp.writeInvocations(), 0, 'Not now runs nothing');
      await assertNotWaitingAfterReload(page, 'deny');
      await page.screenshot({ path: join(outDir, 'ended-7-deny-reloaded.png'), fullPage: true });
      assert.equal(
        await waitingCallIds({ api, sessionId: ids.sessionId, turnId: `${ids.pausedTurnId}-next` }),
        0,
        'the tip waits on nothing',
      );
      await page.close();
    });
    console.log(`ended-card screenshots written to ${outDir}`);
  } finally {
    await browser?.close();
    await vite.close();
    await api.close();
  }
});
