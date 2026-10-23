/**
 * The chat journeys a person takes on a slow self-hosted model, in a real browser against the real
 * server. The scripted model waits before its first word, thinks silently, then writes slowly, so
 * timing bugs that instant fake models hide show up here. Run with `pnpm journey:slow`.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

import configuration from '../../trueforge/src/config.ts';
import { startApprovalTestServer, type ApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import {
  FINAL_TEXT,
  RESEARCH_DIRECTIVE,
  RESEARCH_FETCHES,
  RESEARCH_SEARCHES,
  RUN_DIRECTIVE_PREFIX,
  SEARCH_AGAIN_DIRECTIVE,
  type ModelCall,
  type ModelPacing,
} from '../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

/** A slow self-hosted model: 8 s to the first word, 6 s of silent thinking, then slow writing. */
const SLOW: ModelPacing = { firstTokenMs: 8_000, reasoningMs: 6_000, wordDelayMs: 150 };
/** Still slow, for the replies that call the model ten times. */
const SLOW_STEPS: ModelPacing = { firstTokenMs: 2_000, reasoningMs: 1_000, wordDelayMs: 100 };
/** How long the server keeps preparing a reply before it exists, in the journey that cancels then. */
const ADMISSION_MS = 10_000;
const SCENARIO_LIMIT_MS = 240_000;
const REPLY_LIMIT_MS = 60_000;
const UI_LIMIT_MS = 30_000;
const SEND = 'Send message';
const CANCEL = 'Cancel';
const ALLOW = 'Allow it';
const DENY = 'Not now';

let api: ApprovalTestServer;
let vite: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let origin: string;
const openApiResponses = new Set<ServerResponse>();

before(async () => {
  api = await startApprovalTestServer({ searchProvider: true });
  vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    logLevel: 'error',
    plugins: [inProcessApi(api, openApiResponses)],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
  origin = `http://127.0.0.1:${String(address.port)}`;
  browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
});

after(async () => {
  await browser.close();
  await vite.close();
  await api.close();
});

/** Runs one step of a journey, failing with `what` instead of hanging when it takes too long. */
async function within<T>(what: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not happen within ${String(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls `check` until it holds, failing with `what` when it never does. */
async function until(what: string, ms: number, check: () => Promise<boolean> | boolean): Promise<void> {
  await within(what, ms, async () => {
    while (!(await check())) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  });
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Model calls that offer tools: the reply itself, not titles, summaries or history shortening. */
function replyCalls(): ModelCall[] {
  return api.model.calls().filter(call => call.request.tools.length > 0);
}

function openReplyCalls(): ModelCall[] {
  return replyCalls().filter(call => call.outcome() === 'open');
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function apiJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await api.request(path, init);
  const text = await response.text();
  assert.ok(response.ok, `${init?.method ?? 'GET'} ${path} answered ${String(response.status)}: ${text}`);
  return text === '' ? {} : JSON.parse(text);
}

function readField(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** The chat's turns as the server stores them, oldest first. */
async function turns(sessionId: string): Promise<{ created_at: string; status: string }[]> {
  const page = readField(await apiJson(`/api/v1/sessions/${sessionId}/turns`), 'data');
  if (!Array.isArray(page)) return [];
  return page
    .map((turn: unknown) => ({
      created_at: String(readField(turn, 'created_at')),
      status: String(readField(turn, 'state', 'status')),
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The status of the chat's latest turn as the server stores it, or `none` before any turn. */
async function lastTurnStatus(sessionId: string): Promise<string> {
  return (await turns(sessionId)).at(-1)?.status ?? 'none';
}

async function turnCount(sessionId: string): Promise<number> {
  return (await turns(sessionId)).length;
}

async function setSearchWithoutAsking(value: boolean): Promise<void> {
  await apiJson('/api/v1/user/settings/sentinel', jsonRequest('PATCH', { search_without_asking: value }));
}

function sessionIdOf(page: Page): string {
  const match = /\/sessions\/([^/?#]+)/.exec(page.url());
  if (match?.[1] === undefined) throw new Error(`the page is not on a chat: ${page.url()}`);
  return match[1];
}

function input(page: Page) {
  return page.getByRole('textbox', { name: 'Message input' });
}

async function openHome(page: Page): Promise<void> {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await input(page).waitFor({ timeout: UI_LIMIT_MS });
}

async function openChat(page: Page, sessionId: string): Promise<void> {
  await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await input(page).waitFor({ timeout: UI_LIMIT_MS });
}

/** Types a message and sends it with Enter, as a person does. */
async function send(page: Page, text: string): Promise<void> {
  await input(page).fill(text);
  await input(page).press('Enter');
}

/** Starts a new chat from home with one quick exchange, then names it so the chat list can find it. */
async function quickChat(page: Page, title: string): Promise<string> {
  api.model.setPacing(undefined);
  await openHome(page);
  await send(page, `${title} first message`);
  await page.waitForURL(/\/sessions\//, { timeout: UI_LIMIT_MS });
  const sessionId = sessionIdOf(page);
  await waitForIdle(page, `the first reply in ${title}`);
  await apiJson(`/api/v1/sessions/${sessionId}`, jsonRequest('PATCH', { title }));
  // The chat list read the old name before the rename; opening the chat again shows the new one.
  await openChat(page, sessionId);
  await page.getByText(title, { exact: true }).first().waitFor({ timeout: UI_LIMIT_MS });
  return sessionId;
}

function assistantReplies(page: Page) {
  return page.locator('[data-role="assistant"]');
}

/** Waits until the chat is ready for the next message: Send is back and Cancel is gone. */
async function waitForIdle(page: Page, what: string, ms: number = REPLY_LIMIT_MS): Promise<void> {
  await until(`${what} finishing (Send back, Cancel gone)`, ms, async () => {
    const sendShown = await page.getByRole('button', { name: SEND, exact: true }).isVisible();
    const cancelShown = await page.getByRole('button', { name: CANCEL, exact: true }).isVisible();
    return sendShown && !cancelShown;
  });
}

async function waitForReplyText(page: Page, what: string, count: number): Promise<void> {
  await until(`${what}: the reply "${FINAL_TEXT}" showing`, REPLY_LIMIT_MS, async () => {
    return (await assistantReplies(page).getByText(FINAL_TEXT).count()) >= count;
  });
}

/** Waits until a reply model call made after the first `since` calls has sent its first word and thinks silently. */
async function waitForThinking({ what, since }: { what: string; since: number }): Promise<ModelCall> {
  let call: ModelCall | undefined;
  await until(`${what}: the model starting to think`, REPLY_LIMIT_MS, () => {
    call = replyCalls()
      .slice(since)
      .find(candidate => candidate.outcome() === 'open');
    return call !== undefined;
  });
  await pause(SLOW.firstTokenMs + 1_000);
  if (call === undefined || call.outcome() !== 'open') {
    throw new Error(`${what}: the model call ended before its thinking phase`);
  }
  return call;
}

/** Opens a chat from the chat list by its name, as a person clicks it. */
async function clickChat(page: Page, title: string): Promise<void> {
  await page.getByText(title, { exact: true }).first().click({ timeout: UI_LIMIT_MS });
  await input(page).waitFor({ timeout: UI_LIMIT_MS });
}

/** The chat is idle with no model call still being written. A waiting card also leaves the chat idle. */
async function settled(page: Page): Promise<boolean> {
  const sendShown = await page.getByRole('button', { name: SEND, exact: true }).isVisible();
  const cancelShown = await page.getByRole('button', { name: CANCEL, exact: true }).isVisible();
  return sendShown && !cancelShown && openReplyCalls().length === 0;
}

async function turnOnAgentDetails(page: Page) {
  const toggle = page.getByRole('button', { name: 'Show agent details' });
  await toggle.click({ timeout: UI_LIMIT_MS });
  await until(
    'agent details turning on',
    UI_LIMIT_MS,
    async () => (await toggle.getAttribute('aria-pressed')) === 'true',
  );
  return toggle;
}

/** Where failure screenshots go: `AMAN_SCREENSHOT_DIR`, else a new temporary folder. */
async function screenshotDir(): Promise<string> {
  const configured = process.env['AMAN_SCREENSHOT_DIR'];
  if (configured != null && configured !== '') {
    await mkdir(configured, { recursive: true });
    return configured;
  }
  return await mkdtemp(join(tmpdir(), 'aman-slow-journey-'));
}

/** What each open window showed when a journey failed: a screenshot and the last reply's text. */
async function describePages(name: string): Promise<string> {
  const dir = await screenshotDir();
  const lines: string[] = [];
  for (const [index, page] of context.pages().entries()) {
    const path = join(dir, `${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}-${String(index)}.png`);
    await page.screenshot({ path, fullPage: true }).catch(() => undefined);
    const lastReply = await assistantReplies(page)
      .last()
      .innerText({ timeout: 1_000 })
      .catch(() => '(no reply shown)');
    lines.push(
      `window ${String(index + 1)} (${page.url()}): last reply "${lastReply.replace(/\s+/g, ' ').slice(0, 300)}"; screenshot ${path}`,
    );
  }
  return lines.join('\n');
}

/** One journey as one test with a hard time limit; a failure names what each window showed. */
function journey(name: string, limitMs: number, body: () => Promise<void>): void {
  test(name, { timeout: limitMs }, async () => {
    try {
      await body();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n${await describePages(name)}`, { cause: error });
    } finally {
      await Promise.all(context.pages().map(page => page.close()));
    }
  });
}

/**
 * Starts recording every moment `text` shows in the chat itself, outside the side panel, so a line
 * that flashes between two polls still counts. Plain text, because a compiled function can reference
 * helpers the page does not have.
 */
async function watchChatFor(page: Page, text: string): Promise<() => Promise<number>> {
  await page.evaluate(`(() => {
    window.__chatSightings = 0;
    const look = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent && node.textContent.includes(${JSON.stringify(text)}) && !node.parentElement.closest('aside')) {
          window.__chatSightings += 1;
        }
      }
    };
    look();
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
  })()`);
  return async () => {
    const sightings: unknown = await page.evaluate('window.__chatSightings');
    return typeof sightings === 'number' ? sightings : 0;
  };
}

/** The visible text of the chat, without the side panel. */
async function chatText(page: Page): Promise<string> {
  const text: unknown = await page.evaluate(`(() => {
    const parts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement;
      if (owner && !owner.closest('aside') && owner.checkVisibility()) parts.push(node.textContent);
    }
    return parts.join(' ');
  })()`);
  return typeof text === 'string' ? text : '';
}

async function freshPage(): Promise<Page> {
  api.model.setPacing(undefined);
  api.setAdmissionDelay(0);
  return await context.newPage();
}

/** Leaves a running reply mid-thought, comes back by `goBack`, and checks it is still live and finishes. */
async function leaveAndComeBack({
  page,
  label,
  leave,
  comeBack,
}: {
  page: Page;
  label: string;
  leave: () => Promise<void>;
  comeBack: () => Promise<void>;
}): Promise<void> {
  const repliesBefore = await assistantReplies(page).getByText(FINAL_TEXT).count();
  const since = replyCalls().length;
  api.model.setPacing(SLOW);
  await send(page, `${label}: tell me about Lantern Row`);
  const call = await waitForThinking({ what: label, since });
  await leave();
  await pause(1_000);
  await comeBack();
  assert.equal(call.outcome(), 'open', `${label}: the reply was still being written when the chat was opened again`);
  await until(`${label}: Cancel showing while the reply is still running`, UI_LIMIT_MS, async () => {
    return await page.getByRole('button', { name: CANCEL, exact: true }).isVisible();
  });
  await waitForReplyText(page, `${label}: the reply finishing live, without a reload`, repliesBefore + 1);
  await waitForIdle(page, label);
}

journey('1. send, wait, the reply arrives', SCENARIO_LIMIT_MS, async () => {
  const page = await freshPage();
  api.model.setPacing(SLOW);
  await openHome(page);
  await send(page, 'Plain question: what is Lantern Row?');
  await page.waitForURL(/\/sessions\//, { timeout: UI_LIMIT_MS });
  await waitForReplyText(page, 'the first reply', 1);
  await waitForIdle(page, 'the first reply');
  assert.equal(await lastTurnStatus(sessionIdOf(page)), 'done', 'the server stores the reply as done');
});

journey(
  '2. switch to another chat while the model thinks, come back: the reply is still live',
  SCENARIO_LIMIT_MS * 2,
  async () => {
    const page = await freshPage();
    const other = 'Journey other chat';
    await quickChat(page, other);
    const plain = 'Journey switch chat';
    const plainId = await quickChat(page, plain);
    await leaveAndComeBack({
      page,
      label: 'through the chat list',
      leave: () => clickChat(page, other),
      comeBack: () => clickChat(page, plain),
    });

    const inFolder = 'Journey folder chat';
    const folderChatId = await quickChat(page, inFolder);
    const folder = await apiJson('/api/v1/session-folders', jsonRequest('POST', { name: 'Journey folder' }));
    const folderId = readField(folder, 'data', 'id');
    assert.equal(typeof folderId, 'string', 'the folder was made');
    await apiJson(`/api/v1/sessions/${folderChatId}/folder`, jsonRequest('PUT', { folder_id: folderId }));
    await openChat(page, folderChatId);
    await leaveAndComeBack({
      page,
      label: 'through a chat inside a folder',
      leave: () => clickChat(page, other),
      comeBack: async () => {
        if (!(await page.getByText(inFolder, { exact: true }).first().isVisible())) {
          await page.getByText('Journey folder', { exact: true }).first().click({ timeout: UI_LIMIT_MS });
        }
        await clickChat(page, inFolder);
      },
    });

    await openChat(page, plainId);
    await leaveAndComeBack({
      page,
      label: 'with the browser back button',
      leave: () => clickChat(page, other),
      comeBack: async () => {
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await page.waitForURL(new RegExp(`/sessions/${plainId}`), { timeout: UI_LIMIT_MS });
        await input(page).waitFor({ timeout: UI_LIMIT_MS });
      },
    });
  },
);

journey('3. Cancel in the first seconds, before the model is called: it stays stopped', SCENARIO_LIMIT_MS, async () => {
  const page = await freshPage();
  const sessionId = await quickChat(page, 'Journey early cancel');
  const callsBefore = replyCalls().length;
  // The server is still preparing the reply, before it exists, as a library check on a slow model keeps it.
  api.setAdmissionDelay(ADMISSION_MS);
  api.model.setPacing(SLOW);
  await send(page, 'Early cancel: tell me about Lantern Row');
  await page.getByRole('button', { name: CANCEL, exact: true }).waitFor({ timeout: UI_LIMIT_MS });
  await pause(1_500);
  assert.equal(replyCalls().length, callsBefore, 'the model was not called yet when Cancel was pressed');
  await page.getByRole('button', { name: CANCEL, exact: true }).click();
  await waitForIdle(page, 'the cancelled reply', UI_LIMIT_MS);
  // Long enough for the preparation to finish and the model to be reached, if anything still runs.
  await pause(ADMISSION_MS + 10_000);
  assert.equal(replyCalls().length, callsBefore, 'no model call happened after Cancel');
  assert.notEqual(await lastTurnStatus(sessionId), 'running', 'the server does not keep the reply running');
  assert.equal(await page.getByRole('button', { name: CANCEL, exact: true }).count(), 0, 'the chat shows it stopped');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await input(page).waitFor({ timeout: UI_LIMIT_MS });
  await pause(5_000);
  await waitForIdle(page, 'the cancelled reply after a reload', UI_LIMIT_MS);
  assert.equal(await assistantReplies(page).getByText(FINAL_TEXT).count(), 1, 'no reply was written after Cancel');
  assert.equal(replyCalls().length, callsBefore, 'nothing restarted the reply after the reload');
});

journey(
  '4. Cancel while the model thinks: the model request stops and nothing restarts',
  SCENARIO_LIMIT_MS,
  async () => {
    const page = await freshPage();
    const sessionId = await quickChat(page, 'Journey thinking cancel');
    const since = replyCalls().length;
    api.model.setPacing(SLOW);
    await send(page, 'Thinking cancel: tell me about Lantern Row');
    const call = await waitForThinking({ what: 'cancel mid-thought', since });
    const callsAtCancel = replyCalls().length;
    await page.getByRole('button', { name: CANCEL, exact: true }).click();
    await until('the model request being cut off after Cancel', 10_000, () => call.outcome() === 'aborted');
    await waitForIdle(page, 'the cancelled reply', UI_LIMIT_MS);
    await until('the server storing the reply as stopped', UI_LIMIT_MS, async () => {
      return (await lastTurnStatus(sessionId)) !== 'running';
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await input(page).waitFor({ timeout: UI_LIMIT_MS });
    await pause(15_000);
    await waitForIdle(page, 'the cancelled reply after a reload', UI_LIMIT_MS);
    assert.equal(replyCalls().length, callsAtCancel, 'nothing called the model again after Cancel');
    assert.equal(
      replyCalls()
        .slice(callsAtCancel - 1)
        .filter(candidate => candidate.outcome() === 'open').length,
      0,
      'no model request is still open',
    );
    assert.equal(await lastTurnStatus(sessionId), 'cancelled', 'the server keeps the reply cancelled');
    assert.equal(await assistantReplies(page).getByText(FINAL_TEXT).count(), 1, 'no reply was written after Cancel');
  },
);

journey(
  '5. two sends in the same second: one runs, the other is refused plainly and kept',
  SCENARIO_LIMIT_MS,
  async () => {
    const first = await freshPage();
    const sessionId = await quickChat(first, 'Journey double send');
    const second = await context.newPage();
    await openChat(second, sessionId);
    const turnsBefore = await turnCount(sessionId);
    const callsBefore = replyCalls().length;
    api.model.setPacing(SLOW);
    const texts = ['Double send one: Lantern Row', 'Double send two: Lantern Row'] as const;
    await input(first).fill(texts[0]);
    await input(second).fill(texts[1]);
    await Promise.all([input(first).press('Enter'), input(second).press('Enter')]);

    await waitForIdle(first, 'the first window', REPLY_LIMIT_MS);
    await waitForIdle(second, 'the second window', REPLY_LIMIT_MS);
    assert.equal(await turnCount(sessionId), turnsBefore + 1, 'exactly one of the two messages became a reply');
    assert.equal(replyCalls().length - callsBefore, 1, 'the model wrote one reply');
    assert.equal(await lastTurnStatus(sessionId), 'done', 'the reply that ran finished');

    const pages = [first, second] as const;
    const kept = await Promise.all(pages.map(async (page, index) => (await input(page).inputValue()) === texts[index]));
    const refusedIndex = kept.indexOf(true);
    assert.notEqual(refusedIndex, -1, 'the refused message is still in its message box');
    const refused = pages[refusedIndex];
    assert.ok(refused !== undefined);
    const alerts = await refused.getByRole('alert').allInnerTexts();
    const status = await refused.getByRole('status').allInnerTexts();
    const said = [...alerts, ...status].join(' ').trim();
    assert.ok(said.length > 0, 'the refused window says why the message was not sent');
    assert.doesNotMatch(said, /\b(409|conflict|tip|turn_id|previous_turn|error:)/i, `the refusal is plain: "${said}"`);
  },
);

journey(
  '6. a search the person said no to is not asked again, and never shows as done',
  SCENARIO_LIMIT_MS,
  async () => {
    const page = await freshPage();
    await quickChat(page, 'Journey declined search');
    await turnOnAgentDetails(page);
    await setSearchWithoutAsking(false);
    try {
      const searchesBefore = api.mcp.webSearchInvocations();
      api.model.setPacing(SLOW_STEPS);
      await send(page, `${RUN_DIRECTIVE_PREFIX}${SEARCH_AGAIN_DIRECTIVE} when does the bakery open?`);
      await page.getByRole('button', { name: DENY }).first().waitFor({ timeout: REPLY_LIMIT_MS });
      const searchedSightings = await watchChatFor(page, 'Searched the web');
      // The person says no to every card, as the owner did.
      let cardsAfterNo = -1;
      let callsAtLastNo = 0;
      await until('the reply finishing after each "no"', REPLY_LIMIT_MS * 2, async () => {
        const card = page.getByRole('button', { name: DENY }).first();
        if (await card.isVisible()) {
          cardsAfterNo += 1;
          callsAtLastNo = replyCalls().length;
          await card.click();
          await card.waitFor({ state: 'hidden', timeout: UI_LIMIT_MS });
          return false;
        }
        return replyCalls().length > callsAtLastNo && (await settled(page));
      });
      assert.equal(
        cardsAfterNo,
        0,
        `no new search card appears in the same reply after a "no" (${String(cardsAfterNo)} did)`,
      );
      assert.equal(await searchedSightings(), 0, 'the declined search never shows as "Searched the web" in the chat');
      assert.equal(api.mcp.webSearchInvocations(), searchesBefore, 'no search ran');
    } finally {
      await setSearchWithoutAsking(true);
    }
  },
);

journey(
  '7. a research reply with 7 searches and 2 page reads is not stopped by the write cap',
  SCENARIO_LIMIT_MS * 2,
  async () => {
    const page = await freshPage();
    const sessionId = await quickChat(page, 'Journey research');
    // Searches set to ask, as the owner had them: each search waits for Allow.
    await setSearchWithoutAsking(false);
    try {
      const searchesBefore = api.mcp.webSearchInvocations();
      const fetchesBefore = api.mcp.webFetchInvocations();
      api.model.setPacing(SLOW_STEPS);
      await send(page, `${RUN_DIRECTIVE_PREFIX}${RESEARCH_DIRECTIVE} the history of Lantern Row`);
      let quietSince = Date.now();
      await until('the research reply finishing', SCENARIO_LIMIT_MS, async () => {
        const allow = page.getByRole('button', { name: ALLOW }).first();
        if (await allow.isVisible()) {
          await allow.click().catch(() => undefined);
          quietSince = Date.now();
          return false;
        }
        if (!(await settled(page))) {
          quietSince = Date.now();
          return false;
        }
        // Settled with no card to answer: the reply ended, whether it answered or was stopped.
        return Date.now() - quietSince > 5_000;
      });
      const searches = api.mcp.webSearchInvocations() - searchesBefore;
      const fetches = api.mcp.webFetchInvocations() - fetchesBefore;
      assert.equal(
        `${String(searches)} searches, ${String(fetches)} page reads`,
        `${String(RESEARCH_SEARCHES)} searches, ${String(RESEARCH_FETCHES)} page reads`,
        'every search and page read ran',
      );
      await waitForReplyText(page, 'the research answer', 2);
      assert.equal(await lastTurnStatus(sessionId), 'done', 'the research reply finished');
    } finally {
      await setSearchWithoutAsking(true);
    }
  },
);

journey(
  '8. the server restarts mid-reply: the chat says the reply ended, and a new message works',
  SCENARIO_LIMIT_MS,
  async () => {
    const page = await freshPage();
    const sessionId = await quickChat(page, 'Journey restart');
    const since = replyCalls().length;
    api.model.setPacing(SLOW);
    await send(page, 'Restart: tell me about Lantern Row');
    await waitForThinking({ what: 'restart mid-reply', since });
    // The process dies: its database closes and every connection it held drops.
    await api.restart();
    api.model.hangUpAll();
    for (const response of openApiResponses) response.destroy();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await input(page).waitFor({ timeout: UI_LIMIT_MS });
    await waitForIdle(page, 'the interrupted reply after the restart', UI_LIMIT_MS);
    const lastReply = assistantReplies(page).last();
    await until('a plain line saying the reply ended', UI_LIMIT_MS, async () => {
      return /\b(ended|stopped|did not finish|interrupted|restarted)\b/i.test(await lastReply.innerText());
    });
    assert.notEqual(await lastTurnStatus(sessionId), 'running', 'the server does not keep the dead reply running');

    const replies = await assistantReplies(page).getByText(FINAL_TEXT).count();
    await send(page, 'After restart: are you there?');
    await waitForReplyText(page, 'a new message after the restart', replies + 1);
    await waitForIdle(page, 'a new message after the restart');
  },
);

journey(
  '9. with agent details on, details stay for the whole reply and a line shows while history shortens',
  SCENARIO_LIMIT_MS,
  async () => {
    const page = await freshPage();
    await quickChat(page, 'Journey details');
    const toggle = await turnOnAgentDetails(page);

    const originalThreshold = configuration.CONTEXT_COMPACTION_THRESHOLD_TOKENS;
    configuration.CONTEXT_COMPACTION_THRESHOLD_TOKENS = 200;
    try {
      const repliesBefore = await assistantReplies(page).getByText(FINAL_TEXT).count();
      const linesBefore = shorteningLines(await chatText(page));
      const callsBefore = api.model.calls().length;
      api.model.setPacing(SLOW);
      await send(page, 'Details: tell me about Lantern Row');
      const details = assistantReplies(page).last().getByTestId('assistant-message-agent-internals');
      await details.waitFor({ timeout: UI_LIMIT_MS });
      let detailsGone = false;
      let shorteningSeen = false;
      let shortening = false;
      await until('the reply finishing with details on', REPLY_LIMIT_MS * 2, async () => {
        // Only while this reply's shortening is still running, and only a line that was not there before.
        const shorteningNow = api.model
          .calls()
          .slice(callsBefore)
          .some(call => isShorteningCall(call) && call.outcome() === 'open');
        shortening = shortening || shorteningNow;
        if (shorteningNow && !shorteningSeen) {
          shorteningSeen = shorteningLines(await chatText(page)).some(line => !linesBefore.includes(line));
        }
        const replyDone = (await assistantReplies(page).getByText(FINAL_TEXT).count()) > repliesBefore;
        if (!replyDone) {
          detailsGone =
            detailsGone || !(await details.isVisible()) || (await toggle.getAttribute('aria-pressed')) !== 'true';
        }
        return replyDone;
      });
      assert.equal(detailsGone, false, 'agent details stayed visible for the whole reply');
      assert.ok(shortening, 'the history was shortened during this reply');
      assert.ok(shorteningSeen, 'a plain line showed while the history was being shortened');
    } finally {
      configuration.CONTEXT_COMPACTION_THRESHOLD_TOKENS = originalThreshold;
    }
  },
);

journey(
  "10. two sends while the last reply's background work still runs: every new reply reaches the model or ends plainly",
  SCENARIO_LIMIT_MS,
  async () => {
    const first = await freshPage();
    const sessionId = await quickChat(first, 'Journey busy chat');
    const second = await context.newPage();
    await openChat(second, sessionId);
    api.model.setPacing(SLOW);
    const repliesBefore = await assistantReplies(first).getByText(FINAL_TEXT).count();
    await send(first, 'Busy chat: tell me about Lantern Row');
    await waitForReplyText(first, 'the reply before the two sends', repliesBefore + 1);
    // The reply is written; its background work (naming the chat, summing it up) still waits on the slow model.
    await until("the reply's background work running on the model", UI_LIMIT_MS, () =>
      api.model.calls().some(call => call.request.tools.length === 0 && call.outcome() === 'open'),
    );
    const turnsBefore = await turnCount(sessionId);
    await openChat(second, sessionId);
    // On a slow model the server prepares each reply for a while before it exists, so both sends wait there together.
    api.setAdmissionDelay(ADMISSION_MS);
    await input(first).fill('Busy chat one: Lantern Row');
    await input(second).fill('Busy chat two: Lantern Row');
    await Promise.all([input(first).press('Enter'), input(second).press('Enter')]);

    await until('every new reply reaching the model or ending', REPLY_LIMIT_MS * 2, async () => {
      const newTurns = (await turns(sessionId)).slice(turnsBefore);
      return newTurns.length > 0 && newTurns.every(turn => turn.status !== 'running');
    });
    await waitForIdle(first, 'the first window', UI_LIMIT_MS);
    await waitForIdle(second, 'the second window', UI_LIMIT_MS);
  },
);

/** Each stretch of chat text saying the history is being shortened now, not that it was. */
function shorteningLines(text: string): string[] {
  return [...text.matchAll(/[^.\n]*\b(shortening|compacting|summari[sz]ing|making room|tidying)\b[^.\n]*/gi)].map(
    match => match[0].trim(),
  );
}

/** The model call that summarizes older history: it carries the transcript and offers no tools. */
function isShorteningCall(call: ModelCall): boolean {
  return (
    call.request.tools.length === 0 &&
    call.request.messages.some(message => JSON.stringify(message.content ?? '').includes('<transcript>'))
  );
}
