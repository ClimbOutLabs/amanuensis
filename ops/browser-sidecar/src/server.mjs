// Private HTTP API in front of a headed Chromium: one persistent profile per person and one tab per
// chat, reached only through the browser gateway, which checks the app server's shared secret before
// it relays a call. Nothing here is published to the host or to any other service.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { chromium } from 'playwright-core';

import { RefAssigner, renderSnapshot } from './snapshot.mjs';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * extract.mjs as one script for the page. `page.evaluate(fn)` sends only the function's own source, so
 * the helpers and tables it uses must travel with it: the whole module goes, minus its `export`s.
 */
const EXTRACT_SCRIPT = `(() => {\n${readFileSync(new URL('./extract.mjs', import.meta.url), 'utf8').replace(
  /^export /gm,
  '',
)}\nreturn extractSnapshotNodes();\n})()`;

/** A URL's scheme, host without a leading `www.`, and port, or undefined for one with no host (about:blank, data:). */
function siteOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return {
      secure: parsed.protocol === 'https:',
      host: parsed.hostname.replace(/^www\./, ''),
      port: parsed.port,
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether `url` is on the site that was opened (`opened`, an address). A site's own `www.` name and a move
 * from http up to https count as the same site, since common sites redirect that way on every visit; a
 * move from https down to http, another host or another port does not.
 */
export function onSameSite({ url, opened }) {
  const target = siteOf(url);
  const site = opened === undefined ? undefined : siteOf(opened);
  if (target === undefined || site === undefined) {
    return false;
  }
  return target.host === site.host && target.port === site.port && (target.secure || !site.secure);
}

/** The most chats one person may have open at once; opening another closes the one used longest ago. */
export const MAX_TABS_PER_PERSON = 8;

/** How many times a read is tried while the page keeps moving to a new page of its site. */
const READ_ATTEMPTS = 3;

/** How many closed chats a person's browser remembers, so a chat whose tab was closed is told so. */
const MAX_REMEMBERED_CLOSED_TABS = 100;

/** Answered by the sidecar itself instead of the network: a browser does not navigate to No Content. */
const STAY_PUT = { status: 204 };

/**
 * One tab per chat. `opened` is the last address the model opened in this chat, which the app server
 * checked and classified. Content from any other site is never returned (see `#checkedPage`), and the
 * page cannot move its own tab to another site (see `guardNavigation` and `guardRedirects`): the
 * person's logins live in this profile, so a page that could send the tab to their mail would otherwise
 * get the mail read back. `goingBack` marks the one history step the model asked for.
 * `refusedRedirect` is where the last navigation tried to redirect to, off the opened site, and
 * `movedTo` is set when the model's own open was refused that way, until the next open.
 * `closedBefore` marks a tab opened again after the cap closed this chat's earlier one.
 */
function createTab({ page, closedBefore }) {
  return {
    page,
    refs: new RefAssigner(),
    opened: undefined,
    goingBack: false,
    refusedRedirect: undefined,
    movedTo: undefined,
    closedBefore,
  };
}

/**
 * Redirects of a tab's own page, checked as each response arrives and before the browser follows it:
 * the browser follows redirects without asking the route handler, so this is where a hop to another
 * site is refused. The page's body is never touched here; it streams to the browser as usual.
 */
async function guardRedirects({ tab, cdp }) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const mainFrameId = frameTree.frame.id;
  cdp.on('Fetch.requestPaused', event => {
    void (async () => {
      const status = event.responseStatusCode ?? 0;
      const location = (event.responseHeaders ?? []).find(header => header.name.toLowerCase() === 'location');
      if (event.frameId === mainFrameId && status >= 300 && status < 400 && location !== undefined) {
        const next = new URL(location.value, event.request.url).href;
        if (!onSameSite({ url: next, opened: tab.opened })) {
          tab.refusedRedirect = next;
          // The redirect's own headers must be replaced, or the browser still follows its Location.
          await cdp.send('Fetch.fulfillRequest', {
            requestId: event.requestId,
            responseCode: STAY_PUT.status,
            responseHeaders: [{ name: 'content-length', value: '0' }],
            body: '',
          });
          return;
        }
      }
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
    })().catch(() => undefined);
  });
  await cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
}

/**
 * The route handler every request in a person's browser passes through. Top-level navigations of a
 * chat's tab may stay on the site that chat opened, and are refused when they would leave it. Pages
 * that are not a chat's tab (a popup) get nothing. Everything else continues to the egress proxy,
 * which checks where it goes.
 */
async function guardNavigation(profile, route) {
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
  const tab = profile.tabsByPage.get(frame.page());
  if (tab === undefined) {
    return route.abort('blockedbyclient');
  }
  if (frame.parentFrame() !== null) {
    return route.continue();
  }
  if (tab.goingBack && request.method() === 'GET') {
    // History may hold another site; `#checkedPage` then reports it as moved instead of reading it.
    tab.goingBack = false;
    return route.continue();
  }
  if (onSameSite({ url: request.url(), opened: tab.opened })) {
    return route.continue();
  }
  return route.fulfill(STAY_PUT);
}

/**
 * The checks the egress gateway runs for an address, asked before the browser is touched so the model
 * gets a plain refusal. The gateway alone resolves names: the browser's network has no other way out.
 */
async function askGateway({ proxyServer, url }) {
  const response = await fetch(`${proxyServer}/check?url=${encodeURIComponent(url)}`);
  const body = await response.json();
  if (body?.ok === true && typeof body.url === 'string') {
    return { ok: true, url: new URL(body.url) };
  }
  return { ok: false, reason: typeof body?.reason === 'string' ? body.reason : 'unresolved' };
}

export class BrowserSidecar {
  #profiles = new Map();
  #profilesDir;
  #navTimeoutMs;
  #launch;
  #proxyServer;

  /**
   * `proxyServer` is the egress gateway every browser request goes through; it is required, so the
   * browser never talks to the network directly.
   */
  constructor({ profilesDir, navTimeoutMs, proxyServer, launch = launchPersistentChromium }) {
    if (typeof proxyServer !== 'string' || proxyServer === '') {
      throw new Error('the browser needs its egress proxy (BROWSER_PROXY)');
    }
    this.#profilesDir = profilesDir;
    this.#navTimeoutMs = navTimeoutMs;
    this.#launch = launch;
    this.#proxyServer = proxyServer;
  }

  /** One browser per person, launched once even when two requests for them arrive together. */
  profileFor(owner) {
    const existing = this.#profiles.get(owner);
    if (existing !== undefined) {
      return existing;
    }
    const starting = this.#startProfile(owner);
    this.#profiles.set(owner, starting);
    starting.catch(() => this.#profiles.delete(owner));
    return starting;
  }

  async #startProfile(owner) {
    const { context, page } = await this.#launch({
      userDataDir: path.join(this.#profilesDir, ownerDirName(owner)),
      proxyServer: this.#proxyServer,
    });
    const profile = {
      context,
      spare: page,
      tabs: new Map(),
      tabsByPage: new Map(),
      closedTabs: new Set(),
      opening: Promise.resolve(),
    };
    // A page may not open windows of its own. Tabs are opened only inside `opening`, so a page that
    // is still not a tab once that settles is a popup: it is closed, and its requests are refused.
    context.on('page', other => {
      void profile.opening.then(() => {
        if (!profile.tabsByPage.has(other)) {
          other.close().catch(() => undefined);
        }
      });
    });
    await context.route('**/*', route => guardNavigation(profile, route));
    return profile;
  }

  /** The tab for one chat, opened on first use; the person's least recently used tab closes past the cap. */
  async tabFor({ owner, tab: tabId }) {
    const profile = await this.profileFor(owner);
    const result = profile.opening.then(async () => {
      const existing = profile.tabs.get(tabId);
      if (existing !== undefined) {
        profile.tabs.delete(tabId);
        profile.tabs.set(tabId, existing);
        return existing;
      }
      const page = profile.spare ?? (await profile.context.newPage());
      profile.spare = undefined;
      const closedBefore = profile.closedTabs.delete(tabId);
      // A download never opens in the browser; refusing it keeps the tab from navigating to a file.
      page.on('download', download => {
        download.cancel().catch(() => undefined);
      });
      const tab = createTab({ page, closedBefore });
      await guardRedirects({ tab, cdp: await profile.context.newCDPSession(page) });
      profile.tabs.set(tabId, tab);
      profile.tabsByPage.set(page, tab);
      if (profile.tabs.size > MAX_TABS_PER_PERSON) {
        const [oldestId, oldest] = profile.tabs.entries().next().value;
        profile.tabs.delete(oldestId);
        profile.tabsByPage.delete(oldest.page);
        profile.closedTabs.add(oldestId);
        if (profile.closedTabs.size > MAX_REMEMBERED_CLOSED_TABS) {
          profile.closedTabs.delete(profile.closedTabs.values().next().value);
        }
        await oldest.page.close().catch(() => undefined);
      }
      return tab;
    });
    profile.opening = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * The chat's page, or where it went instead: when the tab is on a site other than the one the model
   * opened (history, or a redirect that was refused), nothing of it is returned. The model is told the
   * address, and opening it is a new `browser_open` that the app server classifies on its own.
   */
  #checkedPage(tab) {
    if (tab.closedBefore && tab.opened === undefined) {
      return { ok: false, result: { status: 'closed' } };
    }
    if (tab.movedTo !== undefined) {
      return { ok: false, result: { status: 'moved', url: tab.movedTo } };
    }
    const url = tab.page.url();
    if (url === 'about:blank') {
      return { ok: true };
    }
    if (!onSameSite({ url, opened: tab.opened })) {
      return { ok: false, result: { status: 'moved', url } };
    }
    return { ok: true };
  }

  async open({ owner, tab: tabId, url }) {
    const target = await askGateway({ proxyServer: this.#proxyServer, url });
    if (!target.ok) {
      return { status: 'refused', reason: target.reason };
    }
    const tab = await this.tabFor({ owner, tab: tabId });
    tab.refs.reset();
    tab.opened = target.url.href;
    tab.closedBefore = false;
    tab.refusedRedirect = undefined;
    tab.movedTo = undefined;
    try {
      await tab.page.goto(target.url.href, { timeout: this.#navTimeoutMs, waitUntil: 'domcontentloaded' });
    } catch (error) {
      // A refused redirect leaves the navigation without a page, which is reported as the move below.
      if (tab.refusedRedirect === undefined) {
        throw error;
      }
    }
    if (tab.refusedRedirect !== undefined) {
      tab.movedTo = tab.refusedRedirect;
      tab.opened = undefined;
    }
    return this.#read(tab);
  }

  async read({ owner, tab: tabId }) {
    return this.#read(await this.tabFor({ owner, tab: tabId }));
  }

  /**
   * Reads the tab's page. A page that is moving to another page of its site while it is read is read
   * again once the new page has loaded, and checked again first, since where it went may have changed.
   */
  async #read(tab) {
    for (let attempt = 1; ; attempt += 1) {
      const checked = this.#checkedPage(tab);
      if (!checked.ok) {
        return checked.result;
      }
      try {
        const nodes = await tab.page.evaluate(EXTRACT_SCRIPT);
        const refs = tab.refs.refsFor(nodes);
        const text = renderSnapshot({ title: await tab.page.title(), url: tab.page.url(), nodes, refs });
        return { status: 'ok', text };
      } catch (error) {
        if (attempt >= READ_ATTEMPTS || !String(error).includes('Execution context was destroyed')) {
          throw error;
        }
        await tab.page.waitForLoadState('domcontentloaded', { timeout: this.#navTimeoutMs }).catch(() => undefined);
      }
    }
  }

  async scroll({ owner, tab: tabId, direction }) {
    const tab = await this.tabFor({ owner, tab: tabId });
    await tab.page.mouse.wheel(0, direction === 'up' ? -800 : 800);
    return this.#read(tab);
  }

  async back({ owner, tab: tabId }) {
    const tab = await this.tabFor({ owner, tab: tabId });
    tab.refs.reset();
    tab.goingBack = true;
    try {
      await tab.page.goBack({ timeout: this.#navTimeoutMs, waitUntil: 'domcontentloaded' });
    } finally {
      tab.goingBack = false;
    }
    return this.#read(tab);
  }

  async screenshot({ owner, tab: tabId }) {
    const tab = await this.tabFor({ owner, tab: tabId });
    const checked = this.#checkedPage(tab);
    if (!checked.ok) {
      return checked.result;
    }
    const buffer = await tab.page.screenshot({ type: 'png' });
    return { status: 'ok', png_base64: buffer.toString('base64') };
  }

  async close() {
    for (const starting of this.#profiles.values()) {
      const profile = await starting.catch(() => undefined);
      await profile?.context.close();
    }
    this.#profiles.clear();
  }
}

/** Environment variables Chromium may see; nothing else of this process's environment reaches it. */
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
  'POST /open': (sidecar, where, body) => sidecar.open({ ...where, url: body.url }),
  'POST /read': (sidecar, where) => sidecar.read(where),
  'POST /scroll': (sidecar, where, body) => sidecar.scroll({ ...where, direction: body.direction }),
  'POST /back': (sidecar, where) => sidecar.back(where),
  'POST /screenshot': (sidecar, where) => sidecar.screenshot(where),
};

const MAX_ID_LENGTH = 256;
const isId = value => typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;

/** A peer address as the gateway's lookup spells it: an IPv4 client reached over a dual-stack socket loses its prefix. */
function plainAddress(address) {
  return typeof address === 'string' && address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * `allowedPeers` returns the addresses calls may come from: the gateway's, which has checked the app
 * server's secret. Chromium runs in this container, so a call from anywhere in it (loopback, or this
 * container's own address) is refused.
 */
export function createHttpServer({ sidecar, allowedPeers }) {
  if (typeof allowedPeers !== 'function') {
    throw new Error('the browser API needs the gateway it answers (BROWSER_API_PEER)');
  }
  return createServer((req, res) => {
    void (async () => {
      let peers;
      try {
        peers = await allowedPeers();
      } catch {
        peers = [];
      }
      if (!peers.map(plainAddress).includes(plainAddress(req.socket.remoteAddress))) {
        res.writeHead(403).end(JSON.stringify({ status: 'error', message: 'calls come through the gateway only' }));
        return;
      }
      await handleRequest({ req, res, sidecar });
    })();
  });
}

async function handleRequest({ req, res, sidecar }) {
  const route = ROUTES[`${req.method} ${req.url}`];
  if (route === undefined) {
    res.writeHead(404).end(JSON.stringify({ status: 'error', message: 'no such route' }));
    return;
  }
  try {
    const body = await readJsonBody(req);
    // `owner` picks the person's browser profile; `tab` picks the chat's tab inside it.
    if (!isId(body.owner) || !isId(body.tab)) {
      res.writeHead(400).end(JSON.stringify({ status: 'error', message: 'owner and tab are required' }));
      return;
    }
    const result = await route(sidecar, { owner: body.owner, tab: body.tab }, body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    res
      .writeHead(500, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: 'error', message: error instanceof Error ? error.message : 'unknown error' }));
  }
}
