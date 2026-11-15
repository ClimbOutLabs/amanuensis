/** Starts the app on this machine with the demo world, for the tools that open its screens in a browser. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { createServer } from 'vite';

import configuration from '../../../trueforge/src/config.ts';
import { localModelEndpointOf } from '../../../trueforge/src/runtime/remoteAddress.ts';
import {
  startApprovalTestServer,
  type ApprovalTestServer,
} from '../../../trueforge/tests/fixtures/approvalTestServer.ts';
import { FakeSandboxProvider } from '../../../trueforge/tests/fixtures/fakeSandboxProvider.ts';
import { freePort } from '../../tests/journeys/support/builtApp.ts';
import { inProcessApi } from '../../tests/support/approvalChat.ts';
import { findChromiumExecutable } from '../../tests/support/findChromiumExecutable.ts';
import { privateViteCache } from '../../tests/support/viteCache.ts';
import { startDemoModelServer } from './demoModelServer.ts';
import { EXCHANGES, MAILBOX, PROVIDER, TIME_ZONE } from './demoWorld.ts';
import { removeFixtureExtras, seedChats, seedModel, seedSettings, signUpOwner, type OwnerApi } from './seed.ts';

/** One window a screen is opened in. */
export interface ScreenSize {
  label: string;
  viewport: { width: number; height: number };
  phone: boolean;
  /** Dark colours instead of light ones. */
  dark?: boolean;
  /** Picture dots for each screen dot. Leave it out for the sharp pictures the docs use. */
  scale?: number;
}

export const DESKTOP: ScreenSize = { label: 'desktop', viewport: { width: 1440, height: 900 }, phone: false };
export const PHONE: ScreenSize = { label: 'phone', viewport: { width: 390, height: 844 }, phone: true };

export interface DemoApp {
  api: ApprovalTestServer;
  owner: OwnerApi;
  origin: string;
  /** Adds the demo model, the one thing a first run needs. */
  addModel: () => Promise<void>;
  /** Adds everything else in demoWorld.ts. The model must be there first. */
  addEverything: () => Promise<void>;
  /** A fresh browser window of this size, signed in as the owner. */
  newContext: (size: ScreenSize) => Promise<BrowserContext>;
  close: () => Promise<void>;
}

/** `cacheName` keeps this tool's build cache apart from another tool's that runs at the same time. */
export async function startDemoApp(cacheName: string): Promise<DemoApp> {
  const dataDir = await mkdtemp(join(tmpdir(), `aman-${cacheName}-`));
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
  const viteCache = privateViteCache(cacheName);
  const vite = await createServer({
    cacheDir: viteCache.cacheDir,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    logLevel: 'error',
    plugins: [inProcessApi(api)],
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  let browser: Browser | undefined;
  const close = async (): Promise<void> => {
    await browser?.close();
    await vite.close();
    viteCache.remove();
    await api.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  };

  try {
    await vite.listen();
    const origin = `http://127.0.0.1:${String(port)}`;
    const started = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
    browser = started;
    const owner = await signUpOwner(api);
    await removeFixtureExtras(owner);

    const newContext: DemoApp['newContext'] = async size => {
      const context = await started.newContext({
        viewport: size.viewport,
        deviceScaleFactor: size.scale ?? 2,
        isMobile: size.phone,
        hasTouch: size.phone,
        timezoneId: TIME_ZONE,
        locale: 'en-US',
        colorScheme: size.dark === true ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      await context.addCookies([{ ...owner.cookie, url: origin }]);
      return context;
    };

    return {
      api,
      owner,
      origin,
      addModel: () => seedModel({ owner, modelBaseUrl: model.baseUrl }),
      addEverything: async () => {
        await seedSettings(owner);
        const seeding = await newContext(DESKTOP);
        await seedChats({ api, owner, page: await seeding.newPage(), origin });
        await seeding.close();
      },
      newContext,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
