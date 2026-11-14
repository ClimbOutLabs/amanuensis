import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page, type Route } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { DEV_OPTIMIZE_DEPS } from '../src/devPrebundle.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
/** The size of the frame the stand-in sidecar sends: half of a 1280 by 800 viewport. */
const FRAME = { width: 640, height: 400 } as const;
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
] as const;
const THEMES = ['light', 'dark'] as const;

interface LiveCall {
  path: string;
  body: unknown;
  /** Acts still waiting for their answer when this one was sent. */
  inputsInFlight: number;
}

/** Said by the stand-in, as the app server says it, for a file the page has nowhere to put. */
const NO_PLACE_FOR_FILE = 'This page has no place to upload a file. Click its upload button first.';

/** The text the stand-in says is selected in the tab. */
const COPIED_TEXT = 'ORDER-12345';

/** A plain JPEG of the frame's size, made by the test browser itself. */
async function makeFrame(browser: Browser): Promise<string> {
  const context = await browser.newContext({ viewport: FRAME, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent('<body style="margin:0;background:#3a6ea5"></body>');
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 60 });
  await context.close();
  return jpeg.toString('base64');
}

/** Answers the page's live calls the way the app server does, and records each one. */
async function answerLiveRoutes(page: Page, options: { frame: string; tabs: unknown[] }): Promise<LiveCall[]> {
  const calls: LiveCall[] = [];
  let inputsInFlight = 0;
  // Whose hand holds the tab, as the sidecar would report it; while the person holds it, the page
  // is showing a human check, which is the moment takeover exists for.
  let takeoverOn = false;
  await page.route('**/api/browser/live/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body: unknown = request.method() === 'POST' ? request.postDataJSON() : undefined;
    const call: LiveCall = { path, body, inputsInFlight };
    calls.push(call);
    if (path === '/api/browser/live/input') {
      // The first key typed is slow to answer, as on a busy page; the next must still wait for it.
      inputsInFlight += 1;
      if (bodyOf(call)['text'] === 'a') {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      inputsInFlight -= 1;
    }
    if (path === '/api/browser/live/upload' && bodyOf(call)['name'] === 'nowhere.txt') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: NO_PLACE_FOR_FILE } }),
      });
      return;
    }
    if (path === '/api/browser/live/takeover') {
      takeoverOn = bodyOf(call)['on'] === true;
    }
    const data =
      path === '/api/browser/live/tabs'
        ? { tabs: options.tabs }
        : path === '/api/browser/live/frame'
          ? {
              status: 'ok',
              jpeg_base64: options.frame,
              width: 1280,
              height: 800,
              takeover: takeoverOn,
              challenge: takeoverOn,
            }
          : path === '/api/browser/live/takeover'
            ? { status: 'ok', takeover: takeoverOn }
            : path === '/api/browser/live/copy'
              ? { text: COPIED_TEXT }
              : { status: 'ok' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return calls;
}

test('the live browser page shows the tab and sends clicks, typing and files to it', { timeout: 300_000 }, async () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const viteCache = privateViteCache('browser-live');
  const server = await createServer({
    cacheDir: viteCache.cacheDir,
    configFile: false,
    optimizeDeps: DEV_OPTIMIZE_DEPS,
    root: frontendRoot,
    logLevel: 'silent',
    // The published ui dist leaves core modules external, so resolve them from source like the app does.
    resolve: { conditions: ['trueforge-dev', ...defaultClientConditions] },
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser: Browser | undefined;

  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
    const fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/browser-live.fixture.html`;

    browser = await chromium.launch({
      executablePath: findChromiumExecutable(chromium.executablePath()),
      headless: true,
    });
    const frame = await makeFrame(browser);

    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        const label = `${viewport.width}px ${theme}`;
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const page = await context.newPage();
        const calls = await answerLiveRoutes(page, {
          frame,
          tabs: [
            { tab: 'chat-1', title: 'Sign in', url: 'https://example.test/login' },
            { tab: 'chat-2', title: '', url: 'https://example.test/upload' },
          ],
        });
        await page.goto(`${fixtureUrl}?theme=${theme}`, {
          waitUntil: 'domcontentloaded',
          timeout: FIRST_LOAD_TIMEOUT_MS,
        });
        await checkLivePage(page, calls, label);
        await context.close();
      }
    }

    // With no page open, the person is told to ask Aman first, and no frame is asked for.
    const context = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 1 });
    const page = await context.newPage();
    const calls = await answerLiveRoutes(page, { frame, tabs: [] });
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
    await page.getByText('Aman has no page open right now', { exact: false }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.screenshot({ path: await featureShotPath({ surface: 'screen:browser-live', step: 'no-page-open' }) });
    assert.ok(
      calls.every(call => call.path === '/api/browser/live/tabs'),
      'no tabs: only the tab list is asked for',
    );
    await context.close();
  } catch (error) {
    await saveFailureShots({ browser, surface: 'screen:browser-live' });
    throw error;
  } finally {
    await browser?.close();
    await server.close();
    viteCache.remove();
  }
});

test('leaving the live view hands a taken-over tab back', { timeout: 300_000 }, async () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
  const viteCache = privateViteCache('browser-live-leave');
  const server = await createServer({
    cacheDir: viteCache.cacheDir,
    configFile: false,
    optimizeDeps: DEV_OPTIMIZE_DEPS,
    root: frontendRoot,
    logLevel: 'silent',
    // The published ui dist leaves core modules external, so resolve them from source like the app does.
    resolve: { conditions: ['trueforge-dev', ...defaultClientConditions] },
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser: Browser | undefined;

  /** Opens the live page on one tab and takes the tab over, waiting until the page shows it. */
  async function openTakenOverPage(frame: string): Promise<{ contextPage: Page; calls: LiveCall[] }> {
    if (browser === undefined) throw new Error('the test browser is not open');
    const context = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 1 });
    const contextPage = await context.newPage();
    const calls = await answerLiveRoutes(contextPage, {
      frame,
      tabs: [{ tab: 'chat-1', title: 'Sign in', url: 'https://example.test/login' }],
    });
    const address = server.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
    await contextPage.goto(`http://127.0.0.1:${address.port}/tests/fixtures/browser-live.fixture.html`, {
      waitUntil: 'domcontentloaded',
      timeout: FIRST_LOAD_TIMEOUT_MS,
    });
    await contextPage.getByRole('button', { name: 'Take over' }).click();
    await waitForCall(calls, call => call.path === '/api/browser/live/takeover' && bodyOf(call)['on'] === true);
    await contextPage.getByText('You are driving this page', { exact: false }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    return { contextPage, calls };
  }

  try {
    await server.listen();
    browser = await chromium.launch({
      executablePath: findChromiumExecutable(chromium.executablePath()),
      headless: true,
    });
    const frame = await makeFrame(browser);

    // Done, pressed while the tab is still in the person's hand, hands it back on the way out.
    {
      const { contextPage, calls } = await openTakenOverPage(frame);
      await contextPage.getByRole('button', { name: 'Done' }).click();
      await waitForCall(calls, call => call.path === '/api/browser/live/takeover' && bodyOf(call)['on'] === false);
      await contextPage.context().close();
    }

    // The page going away (pagehide) hands the tab back too.
    {
      const { contextPage, calls } = await openTakenOverPage(frame);
      await contextPage.evaluate(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await waitForCall(calls, call => call.path === '/api/browser/live/takeover' && bodyOf(call)['on'] === false);
      await contextPage.context().close();
    }

    // The live view going out of view stops the frames, and hands the tab back with them.
    {
      const { contextPage, calls } = await openTakenOverPage(frame);
      await contextPage.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitForCall(calls, call => call.path === '/api/browser/live/takeover' && bodyOf(call)['on'] === false);
      await contextPage.context().close();
    }
  } finally {
    await browser?.close();
    await server.close();
    viteCache.remove();
  }
});

async function checkLivePage(page: Page, calls: LiveCall[], label: string) {
  const picture = page.getByRole('img', { name: 'The page Aman has open, as it looks now' });
  await picture.waitFor({ state: 'visible', timeout: RENDER_TIMEOUT_MS });

  // The first tab is shown, and the untitled one is named by its address.
  const tabs = page.getByRole('group', { name: 'Open tabs' });
  assert.equal(await tabs.getByRole('button', { name: 'Sign in' }).getAttribute('aria-pressed'), 'true', label);
  assert.equal(await tabs.getByRole('button', { name: 'https://example.test/upload' }).count(), 1, label);
  assert.deepEqual(
    calls.find(call => call.path === '/api/browser/live/frame')?.body,
    { tab: 'chat-1' },
    `${label}: frames are asked for the shown tab`,
  );

  // A click on the middle of the picture lands on the middle of the frame, whatever size it is drawn at.
  await picture.click();
  const click = bodyOf(await waitForCall(calls, call => isInput(call, 'click')));
  assert.deepEqual(
    { ...click, x: undefined, y: undefined },
    { tab: 'chat-1', kind: 'click', x: undefined, y: undefined, ...frameSize() },
    `${label}: the click names the frame it was read from`,
  );
  // Within a frame pixel or two: the mouse lands on whole screen pixels.
  assert.ok(
    Math.abs(Number(click['x']) - FRAME.width / 2) <= 2 && Math.abs(Number(click['y']) - FRAME.height / 2) <= 2,
    `${label}: the click is sent in frame pixels, got ${String(click['x'])},${String(click['y'])}`,
  );

  // Keys pressed on the picture: a letter is typed, Enter is one named key.
  await page.keyboard.press('a');
  await page.keyboard.press('Enter');
  assert.deepEqual((await waitForCall(calls, call => isInput(call, 'type'))).body, {
    tab: 'chat-1',
    kind: 'type',
    text: 'a',
  });
  assert.deepEqual((await waitForCall(calls, call => isInput(call, 'key'))).body, {
    tab: 'chat-1',
    kind: 'key',
    key: 'Enter',
  });
  // Enter was only sent once the slow "a" had landed, so the page gets them in the order pressed.
  assert.ok(
    calls.filter(call => call.path === '/api/browser/live/input').every(call => call.inputsInFlight === 0),
    `${label}: each act waits for the one before it`,
  );

  // A code typed in the box goes in as one piece of text.
  await page.getByRole('textbox', { name: 'Text to type into the page' }).fill('123456');
  await page.getByRole('button', { name: 'Type it' }).click();
  await waitForCall(calls, call => isInput(call, 'type') && hasText(call, '123456'));

  // Paste on the picture goes in as one paste, line break and all, so the page never sees Enter.
  await page.evaluate(() => navigator.clipboard.writeText('my code\n'));
  await picture.click();
  await page.keyboard.press('ControlOrMeta+V');
  await waitForCall(calls, call => isInput(call, 'paste') && hasText(call, 'my code\n'));

  // Select all goes to the page, and copy brings the page's selected text to this computer's clipboard.
  await page.keyboard.press('ControlOrMeta+A');
  await waitForCall(calls, call => isInput(call, 'key') && bodyOf(call)['key'] === 'ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  await waitForCall(calls, call => call.path === '/api/browser/live/copy' && hasTab(call, 'chat-1'));
  await page.getByText('Copied.', { exact: false }).waitFor({ timeout: RENDER_TIMEOUT_MS });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), COPIED_TEXT, `${label}: copied out`);

  // The buttons do the same, for a phone or a browser with no paste key.
  await page.evaluate(() => navigator.clipboard.writeText('from the button'));
  await page.getByRole('button', { name: 'Paste into page' }).click();
  await waitForCall(calls, call => isInput(call, 'paste') && hasText(call, 'from the button'));

  // A password filled in its own box goes in as a paste, and the box is emptied once it is used.
  const password = page.getByLabel('Password for the page');
  assert.equal(await password.getAttribute('type'), 'password', `${label}: the password is hidden`);
  assert.equal(
    await password.getAttribute('autocomplete'),
    'current-password',
    `${label}: a password manager fills it`,
  );
  assert.equal(
    await page.getByLabel('Name or email for the page').getAttribute('autocomplete'),
    'username',
    `${label}: a password manager fills the name`,
  );
  await password.fill('hunter2');
  await page.getByRole('button', { name: 'Put password in page' }).click();
  await waitForCall(calls, call => isInput(call, 'paste') && hasText(call, 'hunter2'));
  assert.equal(await password.inputValue(), '', `${label}: the password box is emptied`);
  await page.getByLabel('Name or email for the page').fill('ada@example.test');
  await page.getByRole('button', { name: 'Put name in page' }).click();
  await waitForCall(calls, call => isInput(call, 'paste') && hasText(call, 'ada@example.test'));

  // A file goes to the shown tab as base64, with its name and type.
  await page.getByLabel('Upload a file into the page').setInputFiles({
    name: 'id.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  const upload = await waitForCall(calls, call => call.path === '/api/browser/live/upload');
  assert.deepEqual(upload.body, {
    tab: 'chat-1',
    name: 'id.txt',
    mime: 'text/plain',
    data: Buffer.from('hello').toString('base64'),
  });
  await page.getByText('id.txt is in the page', { exact: false }).waitFor({ timeout: RENDER_TIMEOUT_MS });

  // A file the page cannot take shows the app's own reason and what to do.
  await page.getByLabel('Upload a file into the page').setInputFiles({
    name: 'nowhere.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await page.getByText(NO_PLACE_FOR_FILE).waitFor({ timeout: RENDER_TIMEOUT_MS });

  // Takeover: the person's own press streams as a press, a move and a release, never as a click
  // act, and the human check the page is showing is named while they hold the tab.
  await page.getByRole('button', { name: 'Take over' }).click();
  await waitForCall(calls, call => call.path === '/api/browser/live/takeover' && bodyOf(call)['on'] === true);
  await page.getByText('asking for a human check', { exact: false }).waitFor({ timeout: RENDER_TIMEOUT_MS });
  const clicksBefore = calls.filter(call => isInput(call, 'click')).length;
  const box = await picture.boundingBox();
  assert.ok(box !== null, `${label}: the picture has a box to press`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10);
  await page.mouse.up();
  await waitForCall(calls, call => isInput(call, 'up'));
  const pointerKinds = calls.filter(call => call.path === '/api/browser/live/input').map(call => bodyOf(call)['kind']);
  assert.ok(
    pointerKinds.includes('down') && pointerKinds.includes('move'),
    `${label}: the press and its move were sent under takeover`,
  );
  assert.ok(pointerKinds.indexOf('down') < pointerKinds.indexOf('up'), `${label}: the press lands before the release`);
  assert.equal(
    calls.filter(call => isInput(call, 'click')).length,
    clicksBefore,
    `${label}: no click act under takeover`,
  );
  await page.getByRole('button', { name: 'Hand back' }).click();
  await waitForCall(calls, call => call.path === '/api/browser/live/takeover' && bodyOf(call)['on'] === false);

  // Picking the other tab moves the frames to it.
  await tabs.getByRole('button', { name: 'https://example.test/upload' }).click();
  await waitForCall(calls, call => call.path === '/api/browser/live/frame' && hasTab(call, 'chat-2'));

  assert.ok(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= (page.viewportSize()?.width ?? 0),
    `${label}: the page does not scroll sideways`,
  );

  // Done stops asking for frames and sends the person back to the chat to tell Aman.
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByText('Go back to the chat and tell Aman', { exact: false }).waitFor({ timeout: RENDER_TIMEOUT_MS });
  const framesAtDone = calls.filter(call => call.path === '/api/browser/live/frame').length;
  await page.waitForTimeout(1_200);
  assert.equal(
    calls.filter(call => call.path === '/api/browser/live/frame').length,
    framesAtDone,
    `${label}: no frames after Done`,
  );
}

function frameSize() {
  return { image_width: FRAME.width, image_height: FRAME.height };
}

function bodyOf(call: LiveCall): Record<string, unknown> {
  return typeof call.body === 'object' && call.body !== null ? Object.fromEntries(Object.entries(call.body)) : {};
}

function isInput(call: LiveCall, kind: string): boolean {
  return call.path === '/api/browser/live/input' && bodyOf(call)['kind'] === kind;
}

function hasText(call: LiveCall, text: string): boolean {
  return bodyOf(call)['text'] === text;
}

function hasTab(call: LiveCall, tab: string): boolean {
  return bodyOf(call)['tab'] === tab;
}

async function waitForCall(calls: LiveCall[], match: (call: LiveCall) => boolean): Promise<LiveCall> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  for (;;) {
    const found = calls.find(match);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error('the live page did not make the expected call');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
