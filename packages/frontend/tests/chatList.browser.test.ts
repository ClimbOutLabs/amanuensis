import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { startApprovalTestServer, type ApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { finishedSession, inProcessApi } from './support/approvalChat.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const LONG_TITLE = 'Plan the spring garden beds and order seeds before the last frost';

/** Invented chats: which folder each sits in and how many days ago it was last used. */
const CHATS = [
  { title: 'Trip to Lisbon packing list', folder: 'Travel', daysAgo: 0 },
  { title: 'Train times for Porto', folder: 'Travel', daysAgo: 3 },
  { title: LONG_TITLE, folder: 'Home and garden', daysAgo: 1 },
  { title: 'Birthday dinner ideas', folder: undefined, daysAgo: 0 },
  { title: 'Compare two phone plans', folder: undefined, daysAgo: 0 },
  { title: 'Book club notes for March', folder: undefined, daysAgo: 4 },
  { title: 'Fix the squeaky door', folder: undefined, daysAgo: 9 },
] as const;
const FOLDERS = ['Travel', 'Home and garden', 'A folder with a very long name that cannot fit the column'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function dataId(response: Response): Promise<string> {
  const body: unknown = await response.json();
  const id = isRecord(body) && isRecord(body.data) ? body.data.id : undefined;
  if (typeof id !== 'string') throw new Error(`the server gave no id: ${JSON.stringify(body)}`);
  return id;
}

/** Makes the folders and chats, and returns how many days ago each chat should read as last used. */
async function seed(api: ApprovalTestServer): Promise<Map<string, number>> {
  const folderIds = new Map<string, string>();
  for (const name of FOLDERS) {
    folderIds.set(name, await dataId(await api.request('/api/v1/session-folders', jsonInit({ name }))));
  }
  const ages = new Map<string, number>();
  for (const chat of CHATS) {
    const sessionId = await finishedSession({ api, text: 'hello' });
    const renamed = await api.request(`/api/v1/sessions/${sessionId}`, jsonInit({ title: chat.title }, 'PATCH'));
    assert.equal(renamed.status, 200, await renamed.text());
    if (chat.folder !== undefined) {
      const filed = await api.request(
        `/api/v1/sessions/${sessionId}/folder`,
        jsonInit({ folder_id: folderIds.get(chat.folder) }, 'PUT'),
      );
      assert.equal(filed.status, 200, await filed.text());
    }
    ages.set(sessionId, chat.daysAgo);
  }
  return ages;
}

/** Moves each listed chat's dates back by its age, so the list has chats from earlier days. */
function backdate({ value, ages, now }: { value: unknown; ages: Map<string, number>; now: number }): unknown {
  if (Array.isArray(value)) return value.map(item => backdate({ value: item, ages, now }));
  if (!isRecord(value)) return value;
  const id = typeof value.id === 'string' ? value.id : typeof value.session_id === 'string' ? value.session_id : '';
  const daysAgo = ages.get(id);
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] =
      daysAgo !== undefined && daysAgo > 0 && typeof field === 'string' && /_at$/.test(key)
        ? new Date(now - daysAgo * DAY_MS).toISOString()
        : backdate({ value: field, ages, now });
  }
  return out;
}

/** Where the text of each heading and of each chat under it starts, and how big it is. */
async function measure(page: Page) {
  // No named helpers inside evaluate: tsx would wrap them in a helper the page does not have.
  return page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('[data-slot="aui_thread-list-viewport"]')).at(-1);
    if (list === undefined) throw new Error('the chat list is missing');
    const range = document.createRange();
    const sections = [];
    for (const section of Array.from(list.querySelectorAll('section'))) {
      const texts = [];
      for (const el of Array.from(
        section.querySelectorAll(
          '[data-slot="aui_chat-group-label"], [data-slot="aui_thread-list-item-title"], [data-slot="aui_chat-group-empty"]',
        ),
      )) {
        range.selectNodeContents(el);
        texts.push({
          kind: el.getAttribute('data-slot') ?? '',
          left: range.getBoundingClientRect().left,
          fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
        });
      }
      const chevron = section.querySelector('button[aria-expanded] svg');
      sections.push({
        name: section.getAttribute('aria-label') ?? '',
        chevronLeft: chevron === null ? Number.NaN : chevron.getBoundingClientRect().left,
        texts,
      });
    }
    return { sections, sideways: list.scrollWidth - list.clientWidth };
  });
}

test('the chat list sets each group of chats in under its heading', { timeout: 600_000 }, async () => {
  const api = await startApprovalTestServer();
  const ages = await seed(api);
  const viteCache = privateViteCache('chat-list');
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
    browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });

    for (const view of [
      { width: 1440, height: 900, label: 'desktop', theme: 'light' },
      { width: 1440, height: 900, label: 'desktop', theme: 'dark' },
      { width: 390, height: 844, label: 'phone', theme: 'light' },
    ] as const) {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        deviceScaleFactor: 2,
      });
      await context.addInitScript(theme => {
        localStorage.setItem('aui-theme-preference', theme);
      }, view.theme);
      const page = await context.newPage();
      await page.route(/\/api\/v1\/(sessions|session-folders)(\?|\/|$)/, async route => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body: unknown = await response.json().catch(() => undefined);
        if (body === undefined) return route.fulfill({ response });
        return route.fulfill({ response, json: backdate({ value: body, ages, now: Date.now() }) });
      });
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
      if (view.label === 'phone') {
        await page.getByRole('button', { name: /^Navigation/ }).click();
      }
      const list = page.locator('[data-slot="aui_thread-list-viewport"]').last();
      await list
        .getByRole('button', { name: 'Birthday dinner ideas', exact: true })
        .waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
      const earlier = list.getByRole('button', { name: 'Earlier' });
      if ((await earlier.getAttribute('aria-expanded')) === 'false') await earlier.click();
      await page.waitForTimeout(400);
      const step = `${view.label}-${view.theme}`;
      await page.screenshot({ path: await featureShotPath({ surface: 'screen:chat-list', step }) });
      const { sections, sideways } = await measure(page);
      assert.equal(sideways, 0, `${step}: the list does not scroll sideways`);
      assert.deepEqual(
        sections.map(section => section.name),
        [...FOLDERS, 'Today chats', 'Earlier chats'],
        `${step}: every folder and both dated groups show`,
      );
      const chevrons = new Set(sections.map(section => Math.round(section.chevronLeft)));
      assert.equal(chevrons.size, 1, `${step}: every heading's arrow sits on one line down the list`);
      for (const section of sections) {
        const [heading, ...children] = section.texts;
        if (heading === undefined) throw new Error(`${step}: "${section.name}" has no heading text`);
        assert.ok(children.length > 0, `${step}: "${section.name}" shows what is in it`);
        for (const child of children) {
          // Before this fix a dated group's chats started left of its heading, like its siblings.
          assert.ok(
            Math.abs(child.left - heading.left) <= 1,
            `${step}: under "${section.name}" a ${child.kind} starts at ${String(child.left)}, its heading at ${String(heading.left)}`,
          );
          assert.ok(
            heading.fontSize <= child.fontSize,
            `${step}: the "${section.name}" heading is not larger than what is under it`,
          );
        }
      }
      for (const name of FOLDERS) {
        const folder = sections.find(section => section.name === name);
        const title = sections.flatMap(section => section.texts).find(text => text.kind.endsWith('item-title'));
        // Before this fix a folder's name was smaller than the chats inside it.
        assert.equal(folder?.texts[0]?.fontSize, title?.fontSize, `${step}: "${name}" is as large as a chat title`);
      }
      // A phone has no hover, so the folder's settings button has to show without it.
      const manage = list.getByRole('button', { name: 'Manage Travel' });
      const manageOpacity = await manage.evaluate(el => getComputedStyle(el).opacity);
      assert.equal(manageOpacity, view.label === 'phone' ? '1' : '0', `${step}: the folder settings button at rest`);
      if (view.label === 'desktop') {
        await list.getByRole('button', { name: /^Travel/ }).focus();
        await page.keyboard.press('Tab');
        assert.equal(await manage.evaluate(el => getComputedStyle(el).opacity), '1', `${step}: Tab reaches it`);
        await page.waitForTimeout(250);
        await page.screenshot({
          path: await featureShotPath({ surface: 'screen:chat-list', step: `${step}-keyboard` }),
        });
      }
      await context.close();
    }
  } catch (error) {
    await saveFailureShots({ browser, surface: 'screen:chat-list' });
    throw error;
  } finally {
    await browser?.close();
    await vite.close();
    viteCache.remove();
    await api.close();
  }
});
