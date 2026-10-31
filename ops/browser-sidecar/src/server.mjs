// Private HTTP API in front of a headed Chromium: one persistent profile per person, reached only
// from the app server over the Compose network. Every request must carry the shared secret in the
// `X-Browser-Secret` header; nothing here is published to the host or to any other service.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { chromium } from 'playwright-core';

import { elementAtPath, elementInfo, extractSnapshotNodes } from './extract.mjs';
import { RefAssigner, renderSnapshot, sensitivityOf } from './snapshot.mjs';
import { safeNavigationTarget } from './urlSafety.mjs';

const MAX_BODY_BYTES = 256 * 1024;

/** One browser context (and its ref table) per person, kept open across requests so logins survive. */
function createOwnerSession({ context, page }) {
  return { context, page, refs: new RefAssigner() };
}

export class BrowserSidecar {
  #sessions = new Map();
  #profilesDir;
  #navTimeoutMs;
  #launch;

  constructor({ profilesDir, navTimeoutMs, launch = launchPersistentChromium }) {
    this.#profilesDir = profilesDir;
    this.#navTimeoutMs = navTimeoutMs;
    this.#launch = launch;
  }

  async sessionFor(owner) {
    const existing = this.#sessions.get(owner);
    if (existing !== undefined) {
      return existing;
    }
    const { context, page } = await this.#launch({
      userDataDir: path.join(this.#profilesDir, ownerDirName(owner)),
    });
    const session = createOwnerSession({ context, page });
    this.#sessions.set(owner, session);
    return session;
  }

  async open({ owner, url }) {
    const target = await safeNavigationTarget(url);
    if (!target.ok) {
      return { status: 'refused', reason: target.reason };
    }
    const session = await this.sessionFor(owner);
    session.refs.reset();
    await session.page.goto(target.url.toString(), {
      timeout: this.#navTimeoutMs,
      waitUntil: 'domcontentloaded',
    });
    return this.read({ owner });
  }

  async read({ owner }) {
    const session = await this.sessionFor(owner);
    const nodes = await session.page.evaluate(extractSnapshotNodes);
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
    await session.page.goBack({ timeout: this.#navTimeoutMs, waitUntil: 'domcontentloaded' });
    return this.read({ owner });
  }

  async screenshot({ owner }) {
    const session = await this.sessionFor(owner);
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
    const handle = await session.page.evaluateHandle(elementAtPath, path);
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
    const info = await found.session.page.evaluate(elementInfo, found.path);
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

  /** Performs a click already approved (or found Tier 1), then reads the page it lands on. */
  async click({ owner, ref }) {
    const found = await this.#elementFor({ owner, ref });
    if (!found.ok) {
      return { status: 'refused', reason: found.reason };
    }
    found.session.refs.reset();
    await found.element.click({ timeout: this.#navTimeoutMs });
    return this.read({ owner });
  }

  /** Types into a field; refuses a password, card or one-time-code field instead of typing into it. */
  async type({ owner, ref, text }) {
    const found = await this.#elementFor({ owner, ref });
    if (!found.ok) {
      return { status: 'refused', reason: found.reason };
    }
    const info = await found.session.page.evaluate(elementInfo, found.path);
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
    for (const session of this.#sessions.values()) {
      await session.context.close();
    }
    this.#sessions.clear();
  }
}

/** Launches Chromium headed (there is no `headless` option here on purpose), with its own persistent profile. */
async function launchPersistentChromium({ userDataDir }) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: false,
    viewport: { width: 1280, height: 800 },
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
  'POST /click': (sidecar, body) => sidecar.click({ owner: body.owner, ref: body.ref }),
  'POST /type': (sidecar, body) => sidecar.type({ owner: body.owner, ref: body.ref, text: body.text }),
  'POST /select': (sidecar, body) => sidecar.select({ owner: body.owner, ref: body.ref, option: body.option }),
};

export function createHttpServer({ sidecar, secret }) {
  return createServer((req, res) => {
    void handleRequest({ req, res, sidecar, secret });
  });
}

async function handleRequest({ req, res, sidecar, secret }) {
  if (req.headers['x-browser-secret'] !== secret) {
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
