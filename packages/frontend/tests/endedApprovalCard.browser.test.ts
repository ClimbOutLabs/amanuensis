import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { newEventId } from '@truefoundry/trueforge-core/core/events/schema';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type Plugin } from 'vite';

import {
  MODEL_FQN,
  startApprovalTestServer,
  type ApprovalTestServer,
} from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;
const ENDED_NOTE = 'This request ended. Ask again if you still need it.';
const ALLOW = 'Allow it';
const DENY = 'Not now';

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Use the inert connector exactly as instructed.',
  mcp_servers: [
    { name: 'inert', preload: true, require_approval_for_tools: ['@write', '@destructive', '@unclassified'] },
  ],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function screenshotDir(): Promise<string> {
  const configured = process.env.AMAN_SCREENSHOT_DIR;
  if (configured != null && configured !== '') {
    await mkdir(configured, { recursive: true });
    return configured;
  }
  return await mkdtemp(join(tmpdir(), 'aman-ended-card-'));
}

/** Serves `/api/*` from the real server app in this process, as the dev proxy would. */
function inProcessApi(api: ApprovalTestServer): Plugin {
  return {
    name: 'in-process-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (url === undefined || !url.startsWith('/api/')) {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(name, value);
          }
          const method = req.method ?? 'GET';
          const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
          api
            .request(url, { method, headers, body })
            .then(response => {
              res.statusCode = response.status;
              response.headers.forEach((value, name) => res.setHeader(name, value));
              if (response.body === null) {
                res.end();
                return;
              }
              Readable.fromWeb(response.body).pipe(res);
            })
            .catch((error: unknown) => {
              res.statusCode = 500;
              res.end(String(error));
            });
        });
      });
    },
  };
}

/** A real paused turn: the scripted model asks to run the write tool, and the card waits. */
async function pausedSession(api: ApprovalTestServer): Promise<{ sessionId: string; pausedTurnId: string }> {
  const session = await api.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  assert.equal(session.status, 201);
  const sessionId = ((await session.json()) as { data: { id: string } }).data.id;
  const turn = await api.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({ input: [{ type: 'user.message', content: 'run:inert_write please' }], stream: true }),
  );
  assert.equal(turn.status, 200);
  // Draining the stream waits for the turn to pause; its first event names the turn.
  const created =
    /"type":"turn\.created"[^}]*?"turn_id":"([^"]+)"|"turn_id":"([^"]+)"[^}]*?"type":"turn\.created"/.exec(
      await turn.text(),
    );
  const pausedTurnId = created?.[1] ?? created?.[2];
  if (pausedTurnId === undefined) throw new Error('the turn stream named no turn');
  assert.equal(await waitingCallIds({ api, sessionId, turnId: pausedTurnId }), 1);
  return { sessionId, pausedTurnId };
}

/** How many cards a turn still waits on, as the server shows it. */
async function waitingCallIds({
  api,
  sessionId,
  turnId,
}: {
  api: ApprovalTestServer;
  sessionId: string;
  turnId: string;
}): Promise<number> {
  const response = await api.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
  const body = (await response.json()) as {
    data: { state: { status: string; required_actions?: Array<{ tool_calls: unknown[] }> } };
  };
  if (body.data.state.status !== 'done') return 0;
  return (body.data.state.required_actions ?? []).reduce((total, action) => total + action.tool_calls.length, 0);
}

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
  const outDir = await screenshotDir();
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

      await allow.click();
      await page
        .getByText('Nothing was approved or run', { exact: false })
        .first()
        .waitFor({ timeout: RENDER_TIMEOUT_MS });
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

      await deny.click();
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
