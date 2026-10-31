// Private HTTP API in front of a headed Chromium: one persistent profile per person, reached only
// from the app server over the Compose network. Every request must carry the shared secret in the
// `X-Browser-Secret` header; nothing here is published to the host or to any other service.
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { chromium } from 'playwright-core';

import { RefAssigner, renderSnapshot } from './snapshot.mjs';
import { safeNavigationTarget } from './urlSafety.mjs';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * extract.mjs as one script for the page. `page.evaluate(fn)` sends only the function's own source, so
 * the helpers and tables it uses must travel with it: the whole module goes, minus its `export`s.
 */
const EXTRACT_SCRIPT = `(() => {\n${readFileSync(new URL('./extract.mjs', import.meta.url), 'utf8').replace(
  /^export /gm,
  '',
)}\nreturn extractSnapshotNodes();\n})()`;

/** The shortest shared secret the sidecar accepts, the same floor the app server enforces. */
export const MIN_SECRET_LENGTH = 32;

/** The origin of a URL, or undefined for one that has none (about:blank, data:). */
function originOf(url) {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * One browser context (and its ref table) per person, kept open across requests so logins survive.
 *
 * `allowedOrigin` is the site of the last address the model opened, which the app server checked
 * and classified. Content from any other site is never returned (see `#checkedPage`), and the page
 * cannot move its own tab to another site (see `guardNavigation`): the person's logins live in this
 * profile, so a page that could send the tab to their mail would otherwise get the mail read back.
 * `expected` is the one top-level navigation the sidecar itself is about to make on the model's
 * request (the address it opens, or a step back), and is used up by the first request that matches.
 */
function createOwnerSession({ context, page }) {
  const session = { context, page, refs: new RefAssigner(), allowedOrigin: undefined, expected: undefined };
  // A page may not open windows of its own: a popup is closed before it can load anything, and its
  // first request is refused below.
  context.on('page', other => {
    if (other !== session.page) {
      other.close().catch(() => undefined);
    }
  });
  return session;
}

/**
 * The route handler every request in a person's context passes through. Top-level navigations the
 * page starts itself (a script setting `location`, a form that submits itself, a meta refresh) may
 * stay on the opened site, and are refused when they would leave it. Navigations of any other tab
 * are refused outright. Everything else continues to the egress proxy, which checks where it goes.
 */
async function guardNavigation(session, route) {
  const request = route.request();
  if (!request.isNavigationRequest()) {
    return route.continue();
  }
  let frame;
  try {
    frame = request.frame();
  } catch {
    return route.abort('blockedbyclient');
  }
  if (frame.page() !== session.page) {
    return route.abort('blockedbyclient');
  }
  if (frame.parentFrame() !== null) {
    return route.continue();
  }
  const expected = session.expected;
  if (
    expected !== undefined &&
    request.method() === 'GET' &&
    (expected.kind === 'back' || request.url() === expected.url)
  ) {
    session.expected = undefined;
    return route.continue();
  }
  const target = originOf(request.url());
  if (target !== undefined && target === session.allowedOrigin) {
    return route.continue();
  }
  // Answered here with No Content, which a browser does not navigate to: the tab stays on its page,
  // and the request never leaves the browser.
  return route.fulfill({ status: 204 });
}

export class BrowserSidecar {
  #sessions = new Map();
  #profilesDir;
  #navTimeoutMs;
  #launch;
  #proxyServer;
  #resolve;

  /**
   * `proxyServer` is the egress gateway every browser request goes through; it is required, so the
   * browser never talks to the network directly. `resolve` stands in for DNS in the early address
   * check, for tests; the same policy (`urlSafety.mjs`) runs either way.
   */
  constructor({ profilesDir, navTimeoutMs, proxyServer, launch = launchPersistentChromium, resolve }) {
    if (typeof proxyServer !== 'string' || proxyServer === '') {
      throw new Error('the browser needs its egress proxy (BROWSER_PROXY)');
    }
    this.#profilesDir = profilesDir;
    this.#navTimeoutMs = navTimeoutMs;
    this.#launch = launch;
    this.#proxyServer = proxyServer;
    this.#resolve = resolve;
  }

  /** One launch per person, even when two requests for them arrive together. */
  sessionFor(owner) {
    const existing = this.#sessions.get(owner);
    if (existing !== undefined) {
      return existing;
    }
    const starting = this.#startSession(owner);
    this.#sessions.set(owner, starting);
    starting.catch(() => this.#sessions.delete(owner));
    return starting;
  }

  async #startSession(owner) {
    const { context, page } = await this.#launch({
      userDataDir: path.join(this.#profilesDir, ownerDirName(owner)),
      proxyServer: this.#proxyServer,
    });
    const session = createOwnerSession({ context, page });
    await context.route('**/*', route => guardNavigation(session, route));
    return session;
  }

  /** Runs one navigation the model asked for: the only kind that may leave the opened site. */
  async #navigate(session, expected, go) {
    session.expected = expected;
    try {
      await go();
    } finally {
      session.expected = undefined;
    }
  }

  /**
   * The person's page, or where it went instead: when the tab is on a site other than the one the
   * model opened (a redirect, or history), nothing of it is returned. The model is told the address,
   * and opening it is a new `browser_open` that the app server classifies on its own.
   */
  #checkedPage(session) {
    const url = session.page.url();
    if (url === 'about:blank') {
      return { ok: true };
    }
    const origin = originOf(url);
    if (origin === undefined || origin !== session.allowedOrigin) {
      return { ok: false, result: { status: 'moved', url } };
    }
    return { ok: true };
  }

  async open({ owner, url }) {
    const target = await safeNavigationTarget(url, { resolve: this.#resolve });
    if (!target.ok) {
      return { status: 'refused', reason: target.reason };
    }
    const session = await this.sessionFor(owner);
    session.refs.reset();
    session.allowedOrigin = target.url.origin;
    await this.#navigate(session, { kind: 'goto', url: target.url.href }, () =>
      session.page.goto(target.url.href, { timeout: this.#navTimeoutMs, waitUntil: 'domcontentloaded' }),
    );
    return this.read({ owner });
  }

  async read({ owner }) {
    const session = await this.sessionFor(owner);
    const checked = this.#checkedPage(session);
    if (!checked.ok) {
      return checked.result;
    }
    const nodes = await session.page.evaluate(EXTRACT_SCRIPT);
    const refs = session.refs.refsFor(nodes);
    const text = renderSnapshot({ title: await session.page.title(), url: session.page.url(), nodes, refs });
    return { status: 'ok', text };
  }

  async scroll({ owner, direction }) {
    const session = await this.sessionFor(owner);
    const amount = direction === 'up' ? -800 : 800;
    await session.page.mouse.wheel(0, amount);
    return this.read({ owner });
  }

  async back({ owner }) {
    const session = await this.sessionFor(owner);
    session.refs.reset();
    await this.#navigate(session, { kind: 'back' }, () =>
      session.page.goBack({ timeout: this.#navTimeoutMs, waitUntil: 'domcontentloaded' }),
    );
    return this.read({ owner });
  }

  async screenshot({ owner }) {
    const session = await this.sessionFor(owner);
    const checked = this.#checkedPage(session);
    if (!checked.ok) {
      return checked.result;
    }
    const buffer = await session.page.screenshot({ type: 'png' });
    return { status: 'ok', png_base64: buffer.toString('base64') };
  }

  async close() {
    for (const starting of this.#sessions.values()) {
      const session = await starting.catch(() => undefined);
      await session?.context.close();
    }
    this.#sessions.clear();
  }
}

/** Environment variables Chromium may see. Everything else, the shared secret first, stays in this process. */
const BROWSER_ENV_KEYS = ['DISPLAY', 'XAUTHORITY', 'HOME', 'PATH', 'LANG', 'TZ', 'XDG_RUNTIME_DIR', 'FONTCONFIG_PATH'];

export function browserEnv(env = process.env) {
  return Object.fromEntries(BROWSER_ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

/**
 * Launches Chromium headed (there is no `headless` option here on purpose), with its own persistent
 * profile, its sandbox on, every request sent through the egress proxy (loopback included: an empty
 * bypass list keeps Chromium from talking to anything directly), and service workers off so no
 * request escapes the route handler.
 */
export async function launchPersistentChromium({ userDataDir, proxyServer, executablePath }) {
  // Chromium's profile lock names the host it ran on, and a recreated container has a new host name, so
  // a lock left by the last container would refuse the profile for good. This sidecar owns the volume
  // and launches each profile once (see `sessionFor`), so a lock found here is always a stale one.
  await Promise.all(
    ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map(name =>
      rm(path.join(userDataDir, name), { force: true }),
    ),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Only for running the tests against a Chromium that is installed elsewhere; the image uses its own.
    ...(executablePath === undefined ? {} : { executablePath }),
    headless: false,
    chromiumSandbox: true,
    env: browserEnv(),
    proxy: { server: proxyServer, bypass: '' },
    serviceWorkers: 'block',
    acceptDownloads: false,
    viewport: { width: 1280, height: 800 },
    // WebRTC may not open its own UDP paths around the proxy.
    args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  // A click that starts a download never opens the download in the browser (see the capability layer,
  // which decides where it is saved); refusing it here keeps the tab itself from navigating to a file.
  page.on('download', download => {
    download.cancel().catch(() => undefined);
  });
  return { context, page };
}

/** The profile folder name for one person: a short hash, never the raw id, in case it is ever logged. */
function ownerDirName(owner) {
  return createHash('sha256').update(owner).digest('hex').slice(0, 32);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : JSON.parse(text);
}

const ROUTES = {
  'POST /open': (sidecar, body) => sidecar.open({ owner: body.owner, url: body.url }),
  'POST /read': (sidecar, body) => sidecar.read({ owner: body.owner }),
  'POST /scroll': (sidecar, body) => sidecar.scroll({ owner: body.owner, direction: body.direction }),
  'POST /back': (sidecar, body) => sidecar.back({ owner: body.owner }),
  'POST /screenshot': (sidecar, body) => sidecar.screenshot({ owner: body.owner }),
};

export function createHttpServer({ sidecar, secret }) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BROWSER_SECRET must be at least ${String(MIN_SECRET_LENGTH)} characters`);
  }
  return createServer((req, res) => {
    void handleRequest({ req, res, sidecar, secret });
  });
}

function secretMatches(given, secret) {
  if (typeof given !== 'string') {
    return false;
  }
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

async function handleRequest({ req, res, sidecar, secret }) {
  if (!secretMatches(req.headers['x-browser-secret'], secret)) {
    res.writeHead(401).end(JSON.stringify({ status: 'error', message: 'wrong or missing secret' }));
    return;
  }
  const route = ROUTES[`${req.method} ${req.url}`];
  if (route === undefined) {
    res.writeHead(404).end(JSON.stringify({ status: 'error', message: 'no such route' }));
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (typeof body.owner !== 'string' || body.owner === '') {
      res.writeHead(400).end(JSON.stringify({ status: 'error', message: 'owner is required' }));
      return;
    }
    const result = await route(sidecar, body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    res
      .writeHead(500, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: 'error', message: error instanceof Error ? error.message : 'unknown error' }));
  }
}
