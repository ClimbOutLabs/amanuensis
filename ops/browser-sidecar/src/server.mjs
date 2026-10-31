// Private HTTP API in front of a headed Chromium: one persistent profile per person, reached only
// from the app server over the Compose network. Every request must carry the shared secret in the
// `X-Browser-Secret` header; nothing here is published to the host or to any other service.
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { chromium } from 'playwright-core';

import { CLICK_GATE_SETTLE_MS, installClickGate } from './clickGate.mjs';
import { pageBridge } from './extract.mjs';
import { RefAssigner, renderSnapshot, sensitivityOf } from './snapshot.mjs';
import { safeNavigationTarget } from './urlSafety.mjs';

const MAX_BODY_BYTES = 256 * 1024;

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
  #log;

  /**
   * `proxyServer` is the egress gateway every browser request goes through; it is required, so the
   * browser never talks to the network directly. `resolve` stands in for DNS in the early address
   * check, for tests; the same policy (`urlSafety.mjs`) runs either way. `log` takes the click
   * gate's own log lines only: never the page's content, never a login.
   */
  constructor({ profilesDir, navTimeoutMs, proxyServer, launch = launchPersistentChromium, resolve, log }) {
    if (typeof proxyServer !== 'string' || proxyServer === '') {
      throw new Error('the browser needs its egress proxy (BROWSER_PROXY)');
    }
    this.#profilesDir = profilesDir;
    this.#navTimeoutMs = navTimeoutMs;
    this.#launch = launch;
    this.#proxyServer = proxyServer;
    this.#resolve = resolve;
    this.#log = log ?? (() => undefined);
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
    const nodes = await session.page.evaluate(pageBridge, { command: 'extractSnapshotNodes' });
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

  /** The live element a ref names, or a refusal: an unknown ref, or one the page no longer has. */
  async #elementFor({ owner, ref }) {
    const session = await this.sessionFor(owner);
    const path = session.refs.resolve(ref);
    if (path === undefined) {
      return { ok: false, reason: 'unknown_ref' };
    }
    const handle = await session.page.evaluateHandle(pageBridge, { command: 'elementAtPath', args: path });
    const element = handle.asElement();
    if (element === null) {
      return { ok: false, reason: 'stale_ref' };
    }
    return { ok: true, session, path, element };
  }

  /** Field, submit and form context for a ref, without changing the page: the click gate's dry run. */
  async clickInfo({ owner, ref }) {
    const found = await this.#elementFor({ owner, ref });
    if (!found.ok) {
      return { status: 'refused', reason: found.reason };
    }
    const info = await found.session.page.evaluate(pageBridge, { command: 'elementInfo', args: found.path });
    if (info === null) {
      return { status: 'refused', reason: 'stale_ref' };
    }
    return {
      status: 'ok',
      site: new URL(found.session.page.url()).hostname,
      accessible_name: info.accessible_name,
      is_form_submit: info.is_form_submit,
      form_values: info.form_values,
    };
  }

  /**
   * Performs a click. `approved` is true only once the person has said OK to this exact click (see
   * browserTier.ts and BrowserTool.liveMintParams on the host); then it is trusted outright. Every
   * other click, the ones the host's own classifier found nothing to ask about, still goes through
   * the gate: a same-site write the click sets off is aborted, and the click comes back as
   * `needs_approval` instead of succeeding, catching a missed commit word.
   */
  async click({ owner, ref, approved }) {
    const found = await this.#elementFor({ owner, ref });
    if (!found.ok) {
      return { status: 'refused', reason: found.reason };
    }
    found.session.refs.reset();
    if (approved === true) {
      await found.element.click({ timeout: this.#navTimeoutMs });
      return this.read({ owner });
    }
    const site = new URL(found.session.page.url()).hostname;
    const gate = await installClickGate({ page: found.session.page, site, log: this.#log });
    try {
      // A blocked navigation can make the click's own wait reject; the gate's record is what
      // decides the outcome, not whether this call itself threw.
      await found.element.click({ timeout: this.#navTimeoutMs }).catch(() => undefined);
      await found.session.page.waitForTimeout(CLICK_GATE_SETTLE_MS);
    } finally {
      await gate.remove();
    }
    if (gate.blocked.length === 0) {
      return this.read({ owner });
    }
    const info = await found.session.page
      .evaluate(pageBridge, { command: 'elementInfo', args: found.path })
      .catch(() => null);
    const screenshot = await found.session.page.screenshot({ type: 'png' }).catch(() => null);
    return {
      status: 'needs_approval',
      site,
      accessible_name: info?.accessible_name ?? '',
      form_values: info?.form_values ?? {},
      png_base64: screenshot === null ? null : screenshot.toString('base64'),
    };
  }

  /** Types into a field; refuses a password, card or one-time-code field instead of typing into it. */
  async type({ owner, ref, text }) {
    const found = await this.#elementFor({ owner, ref });
    if (!found.ok) {
      return { status: 'refused', reason: found.reason };
    }
    const info = await found.session.page.evaluate(pageBridge, { command: 'elementInfo', args: found.path });
    const sensitive = info === null ? null : sensitivityOf({ field_kind: info.field_kind });
    if (sensitive !== null) {
      return { status: 'refused', reason: 'sensitive_field' };
    }
    await found.element.fill(text, { timeout: this.#navTimeoutMs });
    return this.read({ owner });
  }

  /** Picks an option on a `<select>`, by its value, falling back to its visible label. */
  async select({ owner, ref, option }) {
    const found = await this.#elementFor({ owner, ref });
    if (!found.ok) {
      return { status: 'refused', reason: found.reason };
    }
    try {
      await found.element.selectOption(option, { timeout: this.#navTimeoutMs });
    } catch {
      try {
        await found.element.selectOption({ label: option }, { timeout: this.#navTimeoutMs });
      } catch {
        return { status: 'refused', reason: 'no_such_option' };
      }
    }
    return this.read({ owner });
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
  'POST /click-info': (sidecar, body) => sidecar.clickInfo({ owner: body.owner, ref: body.ref }),
  'POST /click': (sidecar, body) => sidecar.click({ owner: body.owner, ref: body.ref, approved: body.approved }),
  'POST /type': (sidecar, body) => sidecar.type({ owner: body.owner, ref: body.ref, text: body.text }),
  'POST /select': (sidecar, body) => sidecar.select({ owner: body.owner, ref: body.ref, option: body.option }),
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
