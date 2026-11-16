import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { TENANT_ID } from '../../trueforge/src/apis/sessions.ts';
import configuration from '../../trueforge/src/config.ts';
import { MarkdownMemoryClient } from '../../trueforge/src/runtime/memory/markdownMemoryClient.ts';
import { startApprovalTestServer, type ApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { FINAL_TEXT } from '../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { withinDeadline } from './support/deadline.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
// Shorter than the test's own limit, so a stuck test ends itself and cleans up.
const DEADLINE_MS = 240_000;
const SURFACE = 'route:recallExclusion';

/** Two lines on a made-up person's page: one the chat leaves out with ×, one the person deletes. */
const LEFT_OUT = 'Wren is learning the cello.';
const DELETED = 'Wren keeps bees on the allotment.';
const WREN_PAGE = [
  '---',
  'kind: person',
  'title: Wren',
  'aliases: [Wren]',
  'household: false',
  '---',
  '# Wren',
  '',
  '## Now',
  `- ${LEFT_OUT} <!-- fact: id=f_w1 src=you_said since=2026-11-01 -->`,
  `- ${DELETED} <!-- fact: id=f_w2 src=you_said since=2026-11-01 -->`,
  '',
].join('\n');

function pagesDir(): string {
  return new MarkdownMemoryClient({
    baseDir: configuration.MEMORY_MARKDOWN_DIR,
    namespace: TENANT_ID,
    vaultScope: undefined,
  }).pagesWriteDir();
}

async function wrenPage(): Promise<string> {
  return readFile(join(pagesDir(), 'people', 'wren.md'), 'utf8');
}

/** What the model was shown for the newest message: every model request made since `from`. */
function shownSince({ api, from }: { api: ApprovalTestServer; from: number }): string {
  return JSON.stringify(api.model.requests().slice(from));
}

/** The newest change in the page history the Memory screen lists. */
async function newestPageChange(
  api: ApprovalTestServer,
): Promise<{ id: string; message: string; undo_blocked_by: unknown }> {
  const body: unknown = await (await api.request('/api/v1/memory/pages/changes')).json();
  const data = typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined;
  const changes = typeof data === 'object' && data !== null && 'changes' in data ? data.changes : undefined;
  const newest: unknown = Array.isArray(changes) ? changes[0] : undefined;
  if (
    typeof newest !== 'object' ||
    newest === null ||
    !('id' in newest && typeof newest.id === 'string') ||
    !('message' in newest && typeof newest.message === 'string')
  ) {
    throw new Error('the page history lists no change');
  }
  return {
    id: newest.id,
    message: newest.message,
    undo_blocked_by: 'undo_blocked_by' in newest ? newest.undo_blocked_by : undefined,
  };
}

function composer(page: Page) {
  return page.locator('[data-slot="aui_composer-input"]').first();
}

/** Sends a message in the open chat and waits for the scripted reply to it. */
async function send({ page, text, replies }: { page: Page; text: string; replies: number }): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await page
    .locator('main')
    .getByText(FINAL_TEXT)
    .nth(replies - 1)
    .waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/** Opens the panel's From memory fold and returns it. */
async function memoryFold(page: Page) {
  const fold = page.locator('[data-section="memory"]');
  await fold.waitFor({ timeout: RENDER_TIMEOUT_MS });
  if ((await fold.getAttribute('open')) === null) await fold.locator('summary').click();
  return fold;
}

test(
  'a page line in a chat’s From memory panel leaves that chat with ×, and Delete takes it off its page',
  { timeout: DEADLINE_MS + 60_000 },
  async () => {
    const api = await startApprovalTestServer();
    const viteCache = privateViteCache('memory-panel-page-lines');
    const vite = await createServer({
      cacheDir: viteCache.cacheDir,
      root: fileURLToPath(new URL('../', import.meta.url)),
      logLevel: 'error',
      plugins: [inProcessApi(api)],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    let browser: Browser | undefined;
    let step = 'starting the app';
    try {
      await withinDeadline({
        ms: DEADLINE_MS,
        where: () => step,
        run: async () => {
          await mkdir(join(pagesDir(), 'people'), { recursive: true });
          await writeFile(join(pagesDir(), 'people', 'wren.md'), WREN_PAGE);
          await vite.listen();
          const address = vite.httpServer?.address();
          if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
          const origin = `http://127.0.0.1:${address.port}`;
          browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
          const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
          await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
          await composer(page).waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });

          step = 'asking about Wren';
          let from = api.model.requests().length;
          await send({ page, text: 'What do you know about Wren?', replies: 1 });
          assert.match(shownSince({ api, from }), /learning the cello/, 'the first message is shown the whole page');
          const fold = await memoryFold(page);
          const leftOutRow = fold.getByRole('listitem').filter({ hasText: LEFT_OUT });
          const deletedRow = fold.getByRole('listitem').filter({ hasText: DELETED });
          await leftOutRow.waitFor({ timeout: RENDER_TIMEOUT_MS });
          await deletedRow.waitFor({ timeout: RENDER_TIMEOUT_MS });
          await page.screenshot({
            path: await featureShotPath({
              surface: SURFACE,
              step: 'page-lines-listed',
              did: 'Saved a page about Wren with two lines, asked "What do you know about Wren?" and opened From memory.',
              expect: 'Both lines from the page are listed, and each has a × and a Delete.',
            }),
          });

          step = 'taking a line out of the chat with ×';
          await leftOutRow.getByRole('button', { name: `Take this out of this chat: ${LEFT_OUT}` }).click();
          await leftOutRow.waitFor({ state: 'detached', timeout: RENDER_TIMEOUT_MS });
          from = api.model.requests().length;
          await send({ page, text: 'And what else about Wren?', replies: 2 });
          const afterPull = shownSince({ api, from });
          assert.match(afterPull, /bees on the allotment/, 'the page’s other line is still shown in this chat');
          assert.doesNotMatch(afterPull, /learning the cello/, 'the line taken out with × is not shown again here');
          assert.match(await wrenPage(), /learning the cello/, '× leaves the page itself as it was');

          step = 'deleting a line from the page';
          const deleteRow = (await memoryFold(page)).getByRole('listitem').filter({ hasText: DELETED });
          await deleteRow.getByRole('button', { name: `Delete this memory: ${DELETED}` }).click();
          const confirm = deleteRow.getByRole('group', { name: 'Delete this memory?' });
          await confirm.getByText('Delete this line from the page for Wren? It cannot be brought back.').waitFor({
            timeout: RENDER_TIMEOUT_MS,
          });
          await page.screenshot({
            path: await featureShotPath({
              surface: 'route:memoryVault',
              step: 'delete-page-line-asks',
              did: 'In that chat, pressed Delete on the line "Wren keeps bees on the allotment."',
              expect: 'It asks once, naming the page for Wren, before anything is deleted.',
            }),
          });
          assert.match(await wrenPage(), /bees on the allotment/, 'nothing is deleted before the person agrees');
          await confirm.getByRole('button', { name: 'Delete memory' }).click();
          await deleteRow.waitFor({ state: 'detached', timeout: RENDER_TIMEOUT_MS });
          const after = await wrenPage();
          assert.doesNotMatch(after, /bees on the allotment/, 'Delete takes the line off its page');
          assert.match(after, /learning the cello/, 'and leaves the page’s other line');
          step = 'asking about Wren in a new chat';
          await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
          await composer(page).waitFor({ timeout: RENDER_TIMEOUT_MS });
          from = api.model.requests().length;
          await send({ page, text: 'Remind me about Wren.', replies: 1 });
          const newChat = shownSince({ api, from });
          assert.match(newChat, /learning the cello/, 'a new chat is shown the line the first chat left out');
          assert.doesNotMatch(newChat, /bees on the allotment/, 'and never the deleted one');
          await page.screenshot({
            path: await featureShotPath({
              surface: SURFACE,
              step: 'new-chat-after-delete',
              did: 'Started a new chat and asked "Remind me about Wren." after leaving one line out of the first chat and deleting the other.',
              expect: 'From memory in the new chat lists the line about the cello and not the deleted line about bees.',
            }),
          });

          step = 'undoing the delete from the page history';
          const deletion = await newestPageChange(api);
          assert.match(deletion.message, /^You: deleted Wren keeps bees/, 'the page history names the delete plainly');
          assert.equal(deletion.undo_blocked_by, null, 'and it can be undone');
          const undone = await api.request(`/api/v1/memory/pages/changes/${deletion.id}/undo`, { method: 'POST' });
          assert.equal(undone.status, 200);
          assert.match(await wrenPage(), /bees on the allotment/, 'undoing it puts the line back on its page');
        },
      });
    } catch (error) {
      await saveFailureShots({ browser, surface: SURFACE });
      throw error;
    } finally {
      await browser?.close();
      await vite.close();
      viteCache.remove();
      await api.close();
    }
  },
);
