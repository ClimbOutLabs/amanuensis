import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { sendRefusalText } from '../../trueforge-ui/src/utils/turnRefusal.ts';
import { startApprovalTestServer, type ApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import {
  FINAL_TEXT,
  RUN_DIRECTIVE_PREFIX,
  STALL_AT_ONCE_DIRECTIVE,
  STALLED_ANSWER_START,
} from '../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;
/** A name the person chose, so the lines below prove they use it rather than a built-in one. */
const ASSISTANT_NAME = 'Juniper';
const STILL_WORKING = sendRefusalText({ refusal: 'previous_turn_running', assistantName: ASSISTANT_NAME });
const COULD_NOT_START = sendRefusalText({ refusal: 'turn_could_not_start', assistantName: ASSISTANT_NAME });
const STOPPED_BY_RESTART = sendRefusalText({ refusal: 'stopped_by_restart', assistantName: ASSISTANT_NAME });
/** How long the server takes to start a reply in the slow-server cases: longer than leaving and coming back. */
const SLOW_TURN_START_MS = 4_000;
const TURN_CREATE_PATH = /^\/api\/v1\/sessions\/[^/]+\/turns$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

function slowMessage(label: string): string {
  return `${RUN_DIRECTIVE_PREFIX}${STALL_AT_ONCE_DIRECTIVE} ${label}`;
}

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The status of the chat's latest reply, as the server holds it. */
async function latestTurnStatus({ api, sessionId }: { api: ApprovalTestServer; sessionId: string }): Promise<string> {
  // Oldest first; these chats stay well inside one page.
  const list: unknown = await (await api.request(`/api/v1/sessions/${sessionId}/turns`)).json();
  const latest = isRecord(list) && Array.isArray(list.data) ? list.data.at(-1) : undefined;
  const turnId = isRecord(latest) ? latest.id : undefined;
  if (typeof turnId !== 'string') throw new Error('the chat has no reply');
  const turn: unknown = await (await api.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`)).json();
  const state = isRecord(turn) && isRecord(turn.data) ? turn.data.state : undefined;
  const status = isRecord(state) ? state.status : undefined;
  if (typeof status !== 'string') throw new Error('the reply has no status');
  return status;
}

async function waitForTurnStatus({
  api,
  sessionId,
  ready,
}: {
  api: ApprovalTestServer;
  sessionId: string;
  ready: (status: string) => boolean;
}): Promise<string> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  for (;;) {
    const status = await latestTurnStatus({ api, sessionId });
    if (ready(status)) return status;
    if (Date.now() > deadline) throw new Error(`the reply is still ${status}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

function composer(page: Page) {
  return page.getByRole('textbox').first();
}

function chatRow({ page, title }: { page: Page; title: string }) {
  return page.locator('[data-slot="aui_thread-list-item"]').filter({ hasText: title }).getByRole('button').first();
}

/** The one line the chat shows under the composer about its last send. */
function chatNotice(page: Page) {
  return page.locator('[data-role="host-chat-notice"]');
}

function stopButton(page: Page) {
  return page.getByRole('button', { name: 'Stop' });
}

async function sessionIdOf(page: Page): Promise<string> {
  const match = /\/sessions\/([^/?#]+)/.exec(page.url());
  if (match?.[1] === undefined) throw new Error(`not on a chat: ${page.url()}`);
  return match[1];
}

/** The person's messages in the chat on screen, oldest first. */
async function userMessages(page: Page): Promise<string[]> {
  // The first line is the message; a time can follow it.
  return (await page.locator('main [data-role="user"]').allInnerTexts()).map(text => text.trim().split('\n')[0] ?? '');
}

async function send({ page, text }: { page: Page; text: string }): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** A chat with one finished reply, made the way a person makes one. */
async function finishedChat({ page, origin, text }: { page: Page; origin: string; text: string }): Promise<string> {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
  await composer(page).waitFor({ timeout: RENDER_TIMEOUT_MS });
  await send({ page, text });
  await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  await page.waitForURL(/\/sessions\//, { timeout: RENDER_TIMEOUT_MS });
  return await sessionIdOf(page);
}

/** The chat shows `message` with its live reply, and the composer offers Stop. */
async function expectLiveReply({ page, message }: { page: Page; message: string }): Promise<void> {
  await page.locator('main [data-role="user"]').getByText(message).waitFor({ timeout: RENDER_TIMEOUT_MS });
  await page.locator('main').getByText(STALLED_ANSWER_START).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  await stopButton(page).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/** What a full reload of the same chat shows, for comparison. */
async function reloadedUserMessages({ page, message }: { page: Page; message: string }): Promise<string[]> {
  const fresh = await page.context().newPage();
  try {
    await fresh.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
    await expectLiveReply({ page: fresh, message });
    return await userMessages(fresh);
  } finally {
    await fresh.close();
  }
}

async function cancelStopsReply({
  page,
  api,
  sessionId,
}: {
  page: Page;
  api: ApprovalTestServer;
  sessionId: string;
}): Promise<void> {
  await stopButton(page).first().click();
  await stopButton(page).first().waitFor({ state: 'detached', timeout: RENDER_TIMEOUT_MS });
  await waitForTurnStatus({ api, sessionId, ready: status => status !== 'running' });
}

test('a chat left while its reply runs comes back live', { timeout: 900_000 }, async () => {
  const api = await startApprovalTestServer();
  let turnStartDelayMs = 0;
  const vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    logLevel: 'error',
    plugins: [
      inProcessApi(api, {
        beforeRequest: async ({ method, url }) => {
          if (method === 'POST' && TURN_CREATE_PATH.test(url) && turnStartDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, turnStartDelayMs));
          }
        },
      }),
    ],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  let browser: Browser | undefined;
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    const named = await api.request(
      '/api/v1/personalization/profile',
      jsonInit(
        {
          profile: {
            assistant_name: ASSISTANT_NAME,
            assistant_identity: null,
            voice_guidance: null,
            user_profile: null,
            pinned_preferences: [],
          },
        },
        'PUT',
      ),
    );
    assert.equal(named.status, 200, await named.text());
    const alpha = await finishedChat({ page, origin, text: 'alpha chat' });
    const bravo = await finishedChat({ page, origin, text: 'bravo chat' });
    const charlie = await finishedChat({ page, origin, text: 'charlie chat' });
    const folderResponse: unknown = await (
      await api.request('/api/v1/session-folders', jsonInit({ name: 'Work' }))
    ).json();
    const folderId = isRecord(folderResponse) && isRecord(folderResponse.data) ? folderResponse.data.id : undefined;
    assert.equal(typeof folderId, 'string', 'the folder was made');
    const filed = await api.request(`/api/v1/sessions/${charlie}/folder`, jsonInit({ folder_id: folderId }, 'PUT'));
    assert.equal(filed.status, 200, await filed.text());

    await test.test(
      'leaving by the sidebar list and coming back while the server is slow to start the reply',
      async () => {
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
        await chatRow({ page, title: 'alpha chat' }).click();
        await page.waitForURL(`**/sessions/${alpha}`, { timeout: RENDER_TIMEOUT_MS });
        await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
        const message = slowMessage('from the list');
        turnStartDelayMs = SLOW_TURN_START_MS;
        try {
          await send({ page, text: message });
          await chatRow({ page, title: 'bravo chat' }).click();
          await page.waitForURL(`**/sessions/${bravo}`, { timeout: RENDER_TIMEOUT_MS });
          await chatRow({ page, title: 'alpha chat' }).click();
          await page.waitForURL(`**/sessions/${alpha}`, { timeout: RENDER_TIMEOUT_MS });
        } finally {
          turnStartDelayMs = 0;
        }
        // Before this fix, coming back reloaded the chat before the server had the reply, so the
        // message and the reply stayed missing and the composer looked free.
        await expectLiveReply({ page, message });
        assert.deepEqual(await userMessages(page), await reloadedUserMessages({ page, message }));
        await cancelStopsReply({ page, api, sessionId: alpha });
      },
    );

    await test.test('leaving and coming back by a folder row', async () => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      const folderRow = page
        .getByRole('region', { name: 'Work' })
        .locator('[data-slot="aui_thread-list-item"]')
        .filter({ hasText: 'charlie chat' })
        .getByRole('button')
        .first();
      await folderRow.click();
      await page.waitForURL(`**/sessions/${charlie}`, { timeout: RENDER_TIMEOUT_MS });
      await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      const message = slowMessage('from a folder');
      turnStartDelayMs = SLOW_TURN_START_MS;
      try {
        await send({ page, text: message });
        await chatRow({ page, title: 'bravo chat' }).click();
        await page.waitForURL(`**/sessions/${bravo}`, { timeout: RENDER_TIMEOUT_MS });
        await folderRow.click();
        await page.waitForURL(`**/sessions/${charlie}`, { timeout: RENDER_TIMEOUT_MS });
      } finally {
        turnStartDelayMs = 0;
      }
      await expectLiveReply({ page, message });
      assert.deepEqual(await userMessages(page), await reloadedUserMessages({ page, message }));
      await cancelStopsReply({ page, api, sessionId: charlie });
    });

    await test.test('leaving by the sidebar and coming back with the browser back button', async () => {
      // Opened by its address, as a link or a reload opens it.
      await page.goto(`${origin}/sessions/${bravo}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      const message = slowMessage('then back');
      await send({ page, text: message });
      await expectLiveReply({ page, message });
      await chatRow({ page, title: 'alpha chat' }).click();
      await page.waitForURL(`**/sessions/${alpha}`, { timeout: RENDER_TIMEOUT_MS });
      await page.locator('main [data-role="user"]').getByText(message).waitFor({ state: 'detached' });

      await page.goBack();
      await page.waitForURL(`**/sessions/${bravo}`, { timeout: RENDER_TIMEOUT_MS });
      // Before this fix, Back changed the address but kept the other chat on screen.
      await expectLiveReply({ page, message });
      assert.deepEqual(await userMessages(page), await reloadedUserMessages({ page, message }));
      await cancelStopsReply({ page, api, sessionId: bravo });
    });

    await test.test(
      'a send refused because the last reply still runs keeps the text and shows that reply',
      async () => {
        await page.goto(`${origin}/sessions/${charlie}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
        await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
        const before = await userMessages(page);
        // A reply started somewhere this page does not know about, such as another tab.
        const started = await api.request(
          `/api/v1/sessions/${charlie}/turns`,
          jsonInit({ input: [{ type: 'user.message', content: slowMessage('elsewhere') }], stream: true }),
        );
        assert.equal(started.status, 200);
        // Read like the tab that sent it would: the server moves a reply along as its stream is read.
        const reader = started.body?.getReader();
        const drained = (async () => {
          while (reader !== undefined && !(await reader.read()).done) {
            /* keep reading */
          }
        })().catch(() => undefined);
        try {
          await waitForTurnStatus({ api, sessionId: charlie, ready: status => status === 'running' });

          // The server answers one message at a time, so it refuses this send while that reply runs.
          const followUp = 'one more thing';
          await send({ page, text: followUp });
          await chatNotice(page).filter({ hasText: STILL_WORKING }).waitFor({ timeout: RENDER_TIMEOUT_MS });
          await expectLiveReply({ page, message: slowMessage('elsewhere') });
          assert.equal(await composer(page).inputValue(), followUp, 'the typed text is still in the composer');
          assert.deepEqual(
            await userMessages(page),
            [...before, slowMessage('elsewhere')],
            'the refused message is not shown',
          );
          assert.equal(await page.getByText(/Request failed/).count(), 0, 'no raw error');
          await cancelStopsReply({ page, api, sessionId: charlie });
        } finally {
          await reader?.cancel();
          await drained;
        }
      },
    );

    await test.test('a send whose reply could not start keeps the text and says so in one line', async () => {
      await page.goto(`${origin}/sessions/${alpha}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      const before = await userMessages(page);
      // A server too slow to set the reply up in time answers this way.
      await page.route(
        `**/api/v1/sessions/${alpha}/turns`,
        async route => {
          await route.fulfill({
            status: 409,
            json: {
              error: { message: 'The reply could not start in time.', type: 'conflict', code: 'turn_could_not_start' },
            },
          });
        },
        { times: 1 },
      );
      const text = 'try this once more';
      await send({ page, text });
      await chatNotice(page).filter({ hasText: COULD_NOT_START }).waitFor({ timeout: RENDER_TIMEOUT_MS });
      assert.equal(await composer(page).inputValue(), text, 'the typed text is still in the composer');
      assert.deepEqual(await userMessages(page), before, 'the refused message is not shown');
      assert.equal(await stopButton(page).count(), 0, 'the composer is free');
      assert.equal(await page.getByText(COULD_NOT_START).count(), 1, 'the line is said once, in the chat');
      assert.equal(await page.getByText(/Request failed/).count(), 0, 'no raw error');
    });

    await test.test('a reply running when the server restarts ends with one plain line', async () => {
      await page.goto(`${origin}/sessions/${alpha}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      const message = slowMessage('before the restart');
      await send({ page, text: message });
      await expectLiveReply({ page, message });

      await api.restart();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      await chatNotice(page).filter({ hasText: STOPPED_BY_RESTART }).waitFor({ timeout: RENDER_TIMEOUT_MS });
      assert.equal(await stopButton(page).count(), 0, 'the composer is free');
      assert.equal(await page.getByText('Something went wrong').count(), 0, 'no raw error');
      await waitForTurnStatus({ api, sessionId: alpha, ready: status => status !== 'running' });

      // The chat takes the next message: the server no longer holds a running reply.
      const next = slowMessage('after the restart');
      await send({ page, text: next });
      await expectLiveReply({ page, message: next });
      assert.equal(await chatNotice(page).filter({ hasText: STOPPED_BY_RESTART }).count(), 0);
      assert.equal(await chatNotice(page).filter({ hasText: STILL_WORKING }).count(), 0);
      await cancelStopsReply({ page, api, sessionId: alpha });
    });
  } finally {
    await browser?.close();
    await vite.close();
    await api.close();
  }
});
