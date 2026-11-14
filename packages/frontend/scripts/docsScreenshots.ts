/**
 * Takes every screenshot the help docs need, with the demo world from docsScreenshots/demoWorld.ts, at a
 * computer size and a phone size. This is a tool, not a test: run it with `pnpm docs:screenshots`, or
 * `pnpm docs:screenshots memory-list chats-list` for just those shots.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer } from 'vite';

import configuration from '../../trueforge/src/config.ts';
import { localModelEndpointOf } from '../../trueforge/src/runtime/remoteAddress.ts';
import { startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { FakeSandboxProvider } from '../../trueforge/tests/fixtures/fakeSandboxProvider.ts';
import { freePort } from '../tests/journeys/support/builtApp.ts';
import { inProcessApi } from '../tests/support/approvalChat.ts';
import { findChromiumExecutable } from '../tests/support/findChromiumExecutable.ts';
import { privateViteCache } from '../tests/support/viteCache.ts';
import { startDemoModelServer } from './docsScreenshots/demoModelServer.ts';
import { EXCHANGES, MAILBOX, PROVIDER, TIME_ZONE } from './docsScreenshots/demoWorld.ts';
import {
  removeFixtureExtras,
  seedChats,
  seedModel,
  seedSettings,
  signUpOwner,
  type OwnerApi,
} from './docsScreenshots/seed.ts';
import { SHOTS, type Shot, type World } from './docsScreenshots/shots.ts';
import { STEP_TIMEOUT_MS, type StepContext } from './docsScreenshots/steps.ts';

const OUTPUT_DIR = fileURLToPath(new URL('../../../docs/screenshots/app/', import.meta.url));
const SIZES = [
  { label: 'desktop', viewport: { width: 1440, height: 900 }, phone: false },
  { label: 'phone', viewport: { width: 390, height: 844 }, phone: true },
] as const;
type Size = (typeof SIZES)[number];
const WORLDS: readonly World[] = ['empty', 'model', 'full'];
/** Words that only test data shows. A screenshot that contains one is not saved. */
const TEST_WORDS = ['scripted', 'inert', 'trueforge-default', 'run:', 'Request failed', 'test.example'];
/** How long the screen must stay still before it is pictured. */
const SETTLE_MS = 600;
/** Room left around a cropped part, in CSS pixels. More would take in a sliver of the parts next to it. */
const CROP_MARGIN = 0;

function shotsToTake(names: readonly string[]): readonly Shot[] {
  if (names.length === 0) return SHOTS;
  const unknown = names.filter(name => !SHOTS.some(shot => shot.name === name));
  if (unknown.length > 0) {
    throw new Error(`There is no shot named ${unknown.join(', ')}. Add it to scripts/docsScreenshots/shots.ts first.`);
  }
  return SHOTS.filter(shot => names.includes(shot.name));
}

/** Waits until nothing is loading: no spinner, no busy region, fonts ready and animations done. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForFunction(
    () =>
      document.fonts.status === 'loaded' &&
      document.querySelector('[aria-busy="true"], [role="progressbar"], .animate-spin') === null,
    undefined,
    { timeout: STEP_TIMEOUT_MS },
  );
  await page.waitForTimeout(SETTLE_MS);
}

/** The window area that holds every crop selector's last visible match, with a small margin. */
async function cropArea({ page, selectors }: { page: Page; selectors: readonly string[] }) {
  let area: { left: number; top: number; right: number; bottom: number } | undefined;
  for (const selector of selectors) {
    const box = await page.locator(selector).locator('visible=true').last().boundingBox({ timeout: STEP_TIMEOUT_MS });
    if (box === null) throw new Error(`Nothing on screen matches the crop "${selector}".`);
    area = {
      left: Math.min(area?.left ?? box.x, box.x),
      top: Math.min(area?.top ?? box.y, box.y),
      right: Math.max(area?.right ?? box.x + box.width, box.x + box.width),
      bottom: Math.max(area?.bottom ?? box.y + box.height, box.y + box.height),
    };
  }
  const viewport = page.viewportSize();
  if (area === undefined || viewport === null) return undefined;
  const left = Math.max(0, area.left - CROP_MARGIN);
  const top = Math.max(0, area.top - CROP_MARGIN);
  return {
    x: left,
    y: top,
    width: Math.min(viewport.width, area.right + CROP_MARGIN) - left,
    height: Math.min(viewport.height, area.bottom + CROP_MARGIN) - top,
  };
}

async function newContext({
  browser,
  origin,
  owner,
  size,
}: {
  browser: Browser;
  origin: string;
  owner: OwnerApi;
  size: Size;
}): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: size.viewport,
    deviceScaleFactor: 2,
    isMobile: size.phone,
    hasTouch: size.phone,
    timezoneId: TIME_ZONE,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  await context.addCookies([{ ...owner.cookie, url: origin }]);
  return context;
}

async function takeShot({ shot, size, context }: { shot: Shot; size: Size; context: StepContext }): Promise<string> {
  for (const step of shot.steps) await step(context);
  await settle(context.page);
  const shown = await context.page.locator('body').innerText();
  const found = TEST_WORDS.filter(word => shown.includes(word));
  if (found.length > 0) {
    throw new Error(`The screen shows test text (${found.join(', ')}).`);
  }
  const path = join(OUTPUT_DIR, `${shot.name}-${size.label}.png`);
  const clip = shot.crop === undefined ? undefined : await cropArea({ page: context.page, selectors: shot.crop });
  await context.page.screenshot({
    path,
    animations: 'disabled',
    caret: 'hide',
    ...(clip === undefined ? {} : { clip }),
  });
  return path;
}

async function main(): Promise<void> {
  const shots = shotsToTake(process.argv.slice(2));
  const started = Date.now();
  const dataDir = await mkdtemp(join(tmpdir(), 'aman-docs-shots-'));
  // A picture of each screen that failed, kept after the run so it can be looked at.
  const failedDir = await mkdtemp(join(tmpdir(), 'aman-docs-shots-failed-'));
  // Memory and persona files go to this run's own folder, and no embedding model is fetched.
  configuration.MEMORY_MARKDOWN_DIR = join(dataDir, 'memory');
  configuration.PERSONA_KNOWLEDGE_DIR = join(dataDir, 'persona');
  configuration.MEMORY_EMBEDDINGS_ENABLED = false;
  // Sam's practice inbox and calendar, which stand in for a Google account in the chats that need one.
  const mailboxDir = join(dataDir, 'mailbox');
  await mkdir(join(mailboxDir, 'pages'), { recursive: true });
  await writeFile(join(mailboxDir, 'inbox.json'), JSON.stringify(MAILBOX.inbox));
  await writeFile(join(mailboxDir, 'calendar.json'), JSON.stringify(MAILBOX.calendar));
  configuration.EVAL_FIXTURE_DIR = mailboxDir;
  // Signed-in writes must come from the app's own address, so the server is told the port the app opens on.
  const port = await freePort();
  configuration.PORT = port;

  const model = await startDemoModelServer({
    exchanges: EXCHANGES,
    modelIds: PROVIDER.models.map(entry => entry.model_id),
  });
  const api = await startApprovalTestServer({ localSignIn: true, sandboxProvider: new FakeSandboxProvider(new Map()) });
  // The demo model runs on this computer, so it is named as an allowed local model endpoint, as an operator would.
  const demoEndpoint = localModelEndpointOf(model.baseUrl);
  if (demoEndpoint !== null)
    configuration.LOCAL_MODEL_ENDPOINTS = [...configuration.LOCAL_MODEL_ENDPOINTS, demoEndpoint];
  const viteCache = privateViteCache('docs-screenshots');
  const vite = await createServer({
    cacheDir: viteCache.cacheDir,
    root: fileURLToPath(new URL('../', import.meta.url)),
    logLevel: 'error',
    plugins: [inProcessApi(api)],
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  let browser: Browser | undefined;
  const problems: string[] = [];
  let taken = 0;
  try {
    await vite.listen();
    const origin = `http://127.0.0.1:${String(port)}`;
    browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
    await mkdir(OUTPUT_DIR, { recursive: true });

    const owner = await signUpOwner(api);
    await removeFixtureExtras(owner);
    for (const world of WORLDS) {
      const inWorld = shots.filter(candidate => candidate.world === world);
      if (world === 'model') await seedModel({ owner, modelBaseUrl: model.baseUrl });
      if (world === 'full' && inWorld.length > 0) {
        console.log('Setting up the demo world...');
        await seedSettings(owner);
        const seeding = await newContext({ browser, origin, owner, size: SIZES[0] });
        await seedChats({ api, owner, page: await seeding.newPage(), origin });
        await seeding.close();
      }
      for (const shot of inWorld) {
        // Both sizes of one shot are taken together, so a step that changes the world changes it for both.
        for (const size of SIZES) {
          if (shot.computerOnly === true && size.phone) continue;
          const context = await newContext({ browser, origin, owner, size });
          const page = await context.newPage();
          const failures: string[] = [];
          page.on('pageerror', error => failures.push(`page error: ${error.message}`));
          page.on('response', response => {
            if (response.status() >= 500 && response.url().includes('/api/')) {
              failures.push(`${String(response.status())} from ${response.url()}`);
            }
          });
          taken += 1;
          try {
            const path = await takeShot({ shot, size, context: { page, origin, phone: size.phone, api, owner } });
            console.log(`saved ${path}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(message.split('\n')[0] ?? message);
            await page.screenshot({ path: join(failedDir, `${shot.name}-${size.label}.png`) }).catch(() => undefined);
          }
          problems.push(...failures.map(failure => `${shot.name} ${size.label}: ${failure}`));
          await context.close();
        }
      }
    }
  } finally {
    await browser?.close();
    await vite.close();
    viteCache.remove();
    await api.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`Took ${String(taken)} screenshots in ${String(seconds)} seconds.`);
  if (problems.length > 0) {
    console.error(`Some screens need a look. Pictures of them are in ${failedDir}.\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    await rm(failedDir, { recursive: true, force: true });
  }
}

await main();
