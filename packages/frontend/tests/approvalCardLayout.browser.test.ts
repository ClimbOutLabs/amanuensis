import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type Plugin } from 'vite';

import {
  MODEL_FQN,
  startApprovalTestServer,
  type ApprovalTestServer,
} from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

/**
 * Layout proof for a waiting approval card, against the real app and server.
 *
 * Two faults from the owner's report are pinned here (the third, the right panel calling a
 * waiting card "no activity", is an audit-data question and is not covered by this test):
 * - The scroll-to-bottom arrow floated over the bottom of the message list, where a waiting
 *   card's buttons come to rest when the card is scrolled into view, so it covered them.
 * - A gradient fade over the messages above the composer washed over the bottom of the
 *   card in the same position, so its buttons looked faded, as if the card were disabled.
 *
 * The screenshots show what the person should see: the card at rest, then scrolled up into
 * answering position with the arrow sitting in the composer area, clear of the card.
 */

const RENDER_TIMEOUT_MS = 45_000;
const ALLOW = 'Allow it';
const DENY = 'Not now';
/** How far short of the bottom the thread is scrolled: the natural answering position. */
const SCROLL_UP_PX = 110;

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
  return await mkdtemp(join(tmpdir(), 'aman-card-layout-'));
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

/** Sends one turn and drains its stream, which waits for the turn to finish or pause. */
async function sendTurn(api: ApprovalTestServer, sessionId: string, text: string): Promise<void> {
  const turn = await api.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({ input: [{ type: 'user.message', content: text }], stream: true }),
  );
  assert.equal(turn.status, 200, `turn "${text}" was accepted`);
  await turn.text();
}

/**
 * A session with enough finished conversation to scroll, ending in a turn paused on a
 * waiting approval card.
 */
async function scrollablePausedSession(api: ApprovalTestServer): Promise<string> {
  const session = await api.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  assert.equal(session.status, 201);
  const sessionId = ((await session.json()) as { data: { id: string } }).data.id;
  for (let index = 1; index <= 8; index += 1) {
    await sendTurn(api, sessionId, `Harbour note ${String(index)}: the ferry times are pinned by the office door.`);
  }
  await sendTurn(api, sessionId, 'run:inert_write please');
  return sessionId;
}

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
    const sessionId = await scrollablePausedSession(api);
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
