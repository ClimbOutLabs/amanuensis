import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { MODEL_FQN, startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { FINAL_TEXT } from '../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function composer(page: Page) {
  return page.getByRole('textbox').first();
}

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** With agent details off, no turn on the page shows its steps or tool cards. */
async function checkFolded(page: Page, label: string): Promise<void> {
  const internals = await page.getByTestId('assistant-message-agent-internals').count();
  const main = await page.locator('main').innerText();
  assert.equal(internals, 0, `${label}: an agent internals row is shown while details are off`);
  assert.ok(!main.includes('inert_echo'), `${label}: a finished turn's tool card shows while details are off`);
  assert.ok(!main.includes('inert_write'), `${label}: the running turn's tool card shows while details are off`);
}

test(
  'earlier turns stay folded while a long turn runs, and after a reload mid-turn',
  { timeout: 900_000 },
  async () => {
    const api = await startApprovalTestServer();
    const vite = await createServer({
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
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();

      const created = await api.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
      const createdText = await created.text();
      assert.equal(created.status, 201, createdText);
      const createdBody: unknown = JSON.parse(createdText);
      const sessionId = isRecord(createdBody) && isRecord(createdBody['data']) ? createdBody['data']['id'] : undefined;
      assert.equal(typeof sessionId, 'string', 'the session was made');

      await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
      await composer(page).waitFor({ timeout: RENDER_TIMEOUT_MS });

      // Turns 1 and 2: one tool call each, then a plain answer. They finish.
      await send(page, 'run:inert_echo please');
      await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
      await send(page, 'run:inert_echo again please');
      await page.locator('main').getByText(FINAL_TEXT).nth(1).waitFor({ timeout: RENDER_TIMEOUT_MS });

      const toggle = page.getByRole('button', { name: 'Show agent details' });
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'agent details start off in a new chat');
      await checkFolded(page, 'after turns 1 and 2 finished');

      // Turn 3: a write (approval card), then the model thinks for a long time.
      await send(page, 'run:think_after_write please');
      await page.getByRole('button', { name: 'Allow it' }).first().click({ timeout: RENDER_TIMEOUT_MS });
      await page.waitForTimeout(5_000);
      await checkFolded(page, 'while turn 3 runs');

      // Reload mid-turn: the running turn is resumed from the server.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page
        .locator('main')
        .getByText('run:think_after_write please')
        .first()
        .waitFor({ timeout: RENDER_TIMEOUT_MS });
      await page.waitForTimeout(5_000);
      await checkFolded(page, 'after reload mid-turn');
    } finally {
      await browser?.close();
      await vite.close();
      await api.close();
    }
  },
);
