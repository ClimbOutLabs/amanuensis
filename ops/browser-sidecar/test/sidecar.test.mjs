// Exercises the sidecar in a real, headed, sandboxed Chromium, with every request going through the
// real egress proxy. Only DNS and the proxy's final TCP connect are stood in for: two made-up public
// sites, site-a.test and site-b.test, are served from local fixture servers, and a third fixture
// stands in for everything private (Aman's own server, the metadata address, the home network).
//
// Needs a Chromium for this Playwright release, a display (run under xvfb-run, as the image does) and
// a user that may use the Chromium sandbox (not root). Skipped where any of these is missing, so
// `npm test` on a plain checkout still runs the rest of the suite; `pnpm test:browser-sidecar` runs them
// in the image and requires them. Set BROWSER_CHROMIUM_PATH to use a Chromium installed somewhere else.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { URL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { createEgressProxy } from '../src/egressProxy.mjs';

let BrowserSidecar;
let createHttpServer;
let launchPersistentChromium;
let browsersAvailable = true;
const executablePath = process.env.BROWSER_CHROMIUM_PATH || undefined;
try {
  ({ BrowserSidecar, createHttpServer, launchPersistentChromium } = await import('../src/server.mjs'));
  const { chromium } = await import('playwright-core');
  const probe = await chromium.launch({ headless: false, chromiumSandbox: true, executablePath });
  await probe.close();
} catch (error) {
  // Where the browser is the thing under test (the image, in CI), a missing browser is a failure, not a skip.
  if (process.env.BROWSER_TESTS_REQUIRED === '1') {
    throw new Error('the browser tests must run here, but Chromium could not start', { cause: error });
  }
  browsersAvailable = false;
}

const SITE_A = '93.184.216.34';
const SITE_B = '93.184.216.35';

const CHECKOUT_FIXTURE_HTML = `<!doctype html>
<html>
  <body>
    <h1>Checkout</h1>
    <form id="order-form">
      <label for="name">Name on card</label>
      <input id="name" name="name" value="Ada Lovelace" />
      <label for="country">Country</label>
      <select id="country" name="country">
        <option value="us">United States</option>
        <option value="uk">United Kingdom</option>
      </select>
      <button type="submit" id="place-order">Place order</button>
    </form>
    <dialog open>
      <button type="button" id="dialog-cancel" onclick="this.closest('dialog').close()">Cancel</button>
    </dialog>
  </body>
</html>`;

/** A fixture web server that records every request it gets. */
async function fixture(routes) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    const route = routes[req.url] ?? routes['*'];
    route(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, hits, port: server.address().port };
}

/** A small compressed page that is 128 MB once unpacked: the size the browser, not the sidecar, must hold. */
const BOMB_BYTES = 128 * 1024 * 1024;
const BOMB = gzipSync(
  Buffer.concat([Buffer.from('<!doctype html><h1>Big</h1><!--'), Buffer.alloc(BOMB_BYTES, 'a'), Buffer.from('-->')]),
);

const html = body => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body>${body}</body></html>`);
};

const ACCOUNT_PAGE = html(`
  <h1>Streaming Account</h1>
  <p>Manage your plan below.</p>
  <a href="/help">Help center</a>
  <a href="/cancel">Cancel membership</a>
  <form>
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="current-password" />
    <button type="submit">Sign in</button>
  </form>`);

async function withWorld(run) {
  // Stands in for everything private: if any test's request reaches it, the wall has a hole.
  const internal = await fixture({ '*': html('<h1>Admin API</h1>') });
  const internalUrl = `http://127.0.0.1:${String(internal.port)}`;
  const siteB = await fixture({ '*': html('<h1>Mail inbox</h1><p>Your private messages</p>') });
  const siteA = await fixture({
    '/': ACCOUNT_PAGE,
    '/checkout': (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(CHECKOUT_FIXTURE_HTML),
    '/linked-controls': html(`<h1>Linked controls</h1>
      <form id="linked-form">
        <label for="item">Item</label>
        <input id="item" name="item" value="Notebook" />
        <input type="submit" value="Pay now" />
        <input type="image" alt="Buy with image" style="width: 120px; height: 24px" />
      </form>
      <button type="submit" form="linked-form">Send order</button>
      <input type="submit" form="linked-form" value="Subscribe outside" />`),
    '/redirect-private': (_req, res) => res.writeHead(302, { location: `${internalUrl}/api/admin` }).end(),
    '/redirect-metadata': (_req, res) =>
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(),
    '/redirect-site-b': (_req, res) => res.writeHead(302, { location: 'http://site-b.test/inbox' }).end(),
    '/fetch-private': html(`<h1>Fetcher</h1><script>
      fetch(${JSON.stringify(`${internalUrl}/api/admin`)}, { method: 'POST', mode: 'no-cors', body: 'x' }).catch(() => {});
      fetch('http://rebind.test/api/admin').catch(() => {});
      const img = new Image(); img.src = ${JSON.stringify(`${internalUrl}/pixel`)};
    </script>`),
    '/leave': html(
      `<h1>Leaving</h1><script>setTimeout(() => { location = 'http://site-b.test/inbox'; }, 50);</script>`,
    ),
    '/post-away': html(`<h1>Poster</h1>
      <form id="f" method="POST" action="http://site-b.test/settings/forward"><input name="to" value="x@evil.test"></form>
      <script>setTimeout(() => document.getElementById('f').submit(), 50);</script>`),
    '/popup': html(`<h1>Popup</h1><script>setTimeout(() => window.open('http://site-b.test/inbox'), 50);</script>`),
    '/same-site-nav': html(`<h1>First</h1><script>setTimeout(() => { location = '/'; }, 50);</script>`),
    '/hop-away': html(`<h1>Hopper</h1><script>setTimeout(() => { location = '/redirect-site-b'; }, 50);</script>`),
    '/hop-home': (_req, res) => res.writeHead(302, { location: '/' }).end(),
    // A page that steps forward through history once it loads; no-store keeps it out of the back cache.
    '/goes-forward': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end('<!doctype html><h1>Forwarder</h1><script>setTimeout(() => history.forward(), 100);</script>');
    },
    // Pages that replace their own document with another site's, each in its own way.
    '/replace-away': html(
      `<h1>Replacer</h1><script>setTimeout(() => location.replace('http://site-b.test/inbox'), 50);</script>`,
    ),
    '/refresh-away': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><meta http-equiv="refresh" content="0; url=http://site-b.test/inbox"><h1>Refresher</h1>');
    },
    '/self-away': html(
      `<h1>Self opener</h1><script>setTimeout(() => window.open('http://site-b.test/inbox', '_self'), 50);</script>`,
    ),
    // A page in its own browsing context group, which moves to another page of the site that redirects away.
    '/isolated-hop': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin' });
      res.end(
        `<!doctype html><h1>Isolated</h1><script>setTimeout(() => { location = '/redirect-site-b'; }, 50);</script>`,
      );
    },
    '/to-www': (_req, res) => res.writeHead(302, { location: 'http://www.site-a.test/' }).end(),
    '/bomb': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(BOMB);
    },
    // A page that is ordinary on the first visit and redirects to another site on any later one.
    '/turns-later': (() => {
      let visits = 0;
      return (req, res) => {
        visits += 1;
        if (visits === 1) {
          res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
          res.end('<!doctype html><h1>First visit</h1>');
          return;
        }
        res.writeHead(302, { location: 'http://site-b.test/inbox', 'cache-control': 'no-store' }).end();
      };
    })(),
    '*': html('<h1>Other page</h1>'),
  });

  const names = {
    'site-a.test': [SITE_A],
    'www.site-a.test': [SITE_A],
    'site-b.test': [SITE_B],
    'rebind.test': ['10.0.0.8'],
    'internal.test': ['10.0.0.9'],
  };
  const ports = { [SITE_A]: siteA.port, [SITE_B]: siteB.port };
  const proxy = createEgressProxy({
    resolve: async name => {
      const answer = names[name];
      if (answer === undefined) {
        throw new Error('ENOTFOUND');
      }
      return answer;
    },
    dial: ({ host }) => connect({ host: '127.0.0.1', port: ports[host] ?? 9 }),
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({
    profilesDir,
    navTimeoutMs: 10_000,
    proxyServer: `http://127.0.0.1:${String(proxy.address().port)}`,
    launch: options => launchPersistentChromium({ ...options, executablePath }),
  });
  try {
    await run({ sidecar, siteA, siteB, internal, internalUrl, profilesDir });
  } finally {
    await sidecar.close();
    proxy.close();
    for (const f of [siteA, siteB, internal]) {
      f.server.close();
    }
    await rm(profilesDir, { recursive: true, force: true });
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 500));

test(
  'reads a page through the proxy: title, links, and a masked password field',
  { skip: !browsersAvailable },
  async () => {
    await withWorld(async ({ sidecar }) => {
      const result = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/' });
      assert.equal(result.status, 'ok');
      assert.match(result.text, /Streaming Account/);
      assert.match(result.text, /Cancel membership/);
      assert.doesNotMatch(result.text, /current-password/);
      assert.match(result.text, /\[hidden: password field\]/);
      assert.match(result.text, /Manage your plan below\./);
    });
  },
);

test(
  'a name that resolves to a private address is refused by the gateway before the browser is touched',
  { skip: !browsersAvailable },
  async () => {
    await withWorld(async ({ sidecar, internal }) => {
      const result = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://internal.test/' });
      assert.deepEqual(result, { status: 'refused', reason: 'private_network' });
      assert.deepEqual(internal.hits, []);
    });
  },
);

test(
  'each chat has its own tab: one chat cannot read, or change, the page another opened',
  { skip: !browsersAvailable },
  async () => {
    await withWorld(async ({ sidecar }) => {
      await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-b.test/inbox' });
      assert.deepEqual(await sidecar.read({ owner: 'owner-1', tab: 'chat-2' }), { status: 'closed' });
      await sidecar.open({ owner: 'owner-1', tab: 'chat-2', url: 'http://site-a.test/' });
      const first = await sidecar.read({ owner: 'owner-1', tab: 'chat-1' });
      assert.equal(first.status, 'ok');
      assert.match(first.text, /Mail inbox/);
    });
  },
);

test('a page cannot leave its site through a redirect on its own site', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/hop-away' });
    await settle();
    assert.deepEqual(siteB.hits, []);
    const read = await sidecar.read({ owner: 'owner-1', tab: 'chat-1' });
    assert.equal(read.status, 'ok');
    assert.match(read.text, /Hopper/);
  });
});

test('a redirect that stays on the site is followed', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const result = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/hop-home' });
    assert.equal(result.status, 'ok');
    assert.match(result.text, /Streaming Account/);
  });
});

test('refuses to open a private address before the browser is touched', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, internalUrl, internal }) => {
    const result = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: `${internalUrl}/` });
    assert.deepEqual(result, { status: 'refused', reason: 'private_network' });
    assert.deepEqual(internal.hits, []);
  });
});

for (const [label, route] of [
  ['a redirect to a private address', '/redirect-private'],
  ['a redirect to the cloud metadata address', '/redirect-metadata'],
]) {
  test(`${label} never reaches it, and nothing of it is read`, { skip: !browsersAvailable }, async () => {
    await withWorld(async ({ sidecar, internal }) => {
      const result = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: `http://site-a.test${route}` });
      assert.equal(result.status, 'moved');
      assert.deepEqual(internal.hits, []);
    });
  });
}

test("a page's own requests to private addresses never reach them", { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, internal }) => {
    const result = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/fetch-private' });
    assert.equal(result.status, 'ok');
    await settle();
    assert.deepEqual(internal.hits, []);
  });
});

test('a page cannot move its own tab to another site', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/leave' });
    await settle();
    assert.deepEqual(siteB.hits, []);
    const read = await sidecar.read({ owner: 'owner-1', tab: 'chat-1' });
    assert.equal(read.status, 'ok');
    assert.match(read.text, /Leaving/);
  });
});

test('a page cannot submit a form to another site', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/post-away' });
    await settle();
    assert.deepEqual(siteB.hits, []);
  });
});

test('a page cannot open a window of its own', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/popup' });
    await settle();
    assert.deepEqual(siteB.hits, []);
  });
});

test('a page may still move around its own site', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/same-site-nav' });
    await settle();
    const read = await sidecar.read({ owner: 'owner-1', tab: 'chat-1' });
    assert.equal(read.status, 'ok');
    assert.match(read.text, /Streaming Account/);
  });
});

test(
  'a redirect to another site is not read; opening that site is a new open',
  { skip: !browsersAvailable },
  async () => {
    await withWorld(async ({ sidecar, siteB }) => {
      const moved = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/redirect-site-b' });
      assert.deepEqual(moved, { status: 'moved', url: 'http://site-b.test/inbox' });
      assert.deepEqual(siteB.hits, []);
      assert.equal((await sidecar.read({ owner: 'owner-1', tab: 'chat-1' })).status, 'moved');
      assert.equal((await sidecar.screenshot({ owner: 'owner-1', tab: 'chat-1' })).status, 'moved');
      const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-b.test/inbox' });
      assert.equal(opened.status, 'ok');
      assert.match(opened.text, /Mail inbox/);
      assert.equal(siteB.hits.length, 1);
    });
  },
);

test('going back to another site is not read', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/' });
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-b.test/inbox' });
    const back = await sidecar.back({ owner: 'owner-1', tab: 'chat-1' });
    assert.deepEqual(back, { status: 'moved', url: 'http://site-a.test/' });
  });
});

test('a page cannot step forward through history to another site', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/goes-forward' });
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-b.test/inbox' });
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/' });
    assert.equal((await sidecar.back({ owner: 'owner-1', tab: 'chat-1' })).status, 'moved');
    const hitsBefore = siteB.hits.length;
    const home = await sidecar.back({ owner: 'owner-1', tab: 'chat-1' });
    assert.equal(home.status, 'ok');
    assert.match(home.text, /Forwarder/);
    await settle();
    assert.equal(siteB.hits.length, hitsBefore);
    const read = await sidecar.read({ owner: 'owner-1', tab: 'chat-1' });
    assert.equal(read.status, 'ok');
    assert.match(read.text, /Forwarder/);
  });
});

for (const [label, route, own] of [
  ['replacing itself', '/replace-away', /Replacer/],
  ['a refresh tag', '/refresh-away', /Refresher/],
  ['opening into its own tab', '/self-away', /Self opener/],
  ['a redirect after moving to its own browsing context group', '/isolated-hop', /Isolated/],
]) {
  test(`a page cannot swap itself for another site by ${label}`, { skip: !browsersAvailable }, async () => {
    await withWorld(async ({ sidecar, siteB }) => {
      await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: `http://site-a.test${route}` });
      await settle();
      assert.deepEqual(siteB.hits, []);
      const read = await sidecar.read({ owner: 'owner-1', tab: 'chat-1' });
      assert.equal(read.status, 'ok');
      assert.match(read.text, own);
    });
  });
}

test('Chromium does not get the shared secret', { skip: BrowserSidecar === undefined }, async () => {
  const { browserEnv } = await import('../src/server.mjs');
  const env = browserEnv({ BROWSER_SECRET: 's'.repeat(40), PATH: '/usr/bin', DISPLAY: ':99', HOME: '/home/pwuser' });
  assert.deepEqual(env, { DISPLAY: ':99', HOME: '/home/pwuser', PATH: '/usr/bin' });
});

test('the API answers only the gateway, and needs a person and a chat', async () => {
  if (BrowserSidecar === undefined) {
    return;
  }
  let reads = 0;
  const sidecar = {
    read: async () => {
      reads += 1;
      return { status: 'ok', text: '' };
    },
  };
  assert.throws(() => createHttpServer({ sidecar }), /gateway/);
  const listen = async peers => {
    const server = createHttpServer({ sidecar, allowedPeers: async () => peers });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const post = (server, body) =>
    fetch(`http://127.0.0.1:${String(server.address().port)}/read`, { method: 'POST', body: JSON.stringify(body) });
  // The gateway is somewhere else; this call, like Chromium inside the container, comes from loopback.
  const elsewhere = await listen(['172.30.0.2']);
  try {
    assert.equal((await post(elsewhere, { owner: 'o', tab: 't' })).status, 403);
    assert.equal(reads, 0);
  } finally {
    elsewhere.close();
  }
  const here = await listen(['127.0.0.1']);
  try {
    assert.equal((await post(here, { owner: 'o', tab: 't' })).status, 200);
    assert.equal((await post(here, { owner: 'o' })).status, 400);
    assert.equal(reads, 1);
  } finally {
    here.close();
  }
});

test('the same site, its www name and a move up to https count as one site', async () => {
  if (BrowserSidecar === undefined) {
    return;
  }
  const { onSameSite } = await import('../src/server.mjs');
  const opened = 'http://site-a.test/start';
  assert.equal(onSameSite({ url: 'http://site-a.test/other', opened }), true);
  assert.equal(onSameSite({ url: 'https://www.site-a.test/', opened }), true);
  assert.equal(onSameSite({ url: 'https://site-a.test/', opened: 'https://www.site-a.test/' }), true);
  assert.equal(onSameSite({ url: 'http://site-a.test/', opened: 'https://site-a.test/' }), false);
  assert.equal(onSameSite({ url: 'http://site-a.test:8080/', opened }), false);
  assert.equal(onSameSite({ url: 'http://evil-site-a.test/', opened }), false);
  assert.equal(onSameSite({ url: 'http://site-a.test.evil.test/', opened }), false);
  assert.equal(onSameSite({ url: 'about:blank', opened }), false);
  assert.equal(onSameSite({ url: 'http://site-a.test/', opened: undefined }), false);
});

test('a redirect to the www name of the same site is followed', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const result = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/to-www' });
    assert.equal(result.status, 'ok');
    assert.match(result.text, /www\.site-a\.test/);
  });
});

test('going back cannot follow a redirect to another site', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/turns-later' });
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/' });
    await sidecar.back({ owner: 'owner-1', tab: 'chat-1' }).catch(() => undefined);
    await settle();
    assert.deepEqual(siteB.hits, []);
  });
});

test('a big compressed page is not held in the sidecar', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/' });
    const before = process.memoryUsage().rss;
    const result = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/bomb' });
    assert.equal(result.status, 'ok');
    assert.match(result.text, /Big/);
    const grew = process.memoryUsage().rss - before;
    assert.ok(grew < BOMB_BYTES / 3, `the sidecar grew by ${String(Math.round(grew / 1024 / 1024))} MB`);
  });
});

test(
  'a chat whose tab was closed to make room is told so, and can open its page again',
  { skip: !browsersAvailable },
  async () => {
    const { MAX_TABS_PER_PERSON } = await import('../src/server.mjs');
    await withWorld(async ({ sidecar }) => {
      for (let index = 0; index <= MAX_TABS_PER_PERSON; index += 1) {
        await sidecar.open({ owner: 'owner-1', tab: `chat-${String(index)}`, url: 'http://site-a.test/' });
      }
      assert.deepEqual(await sidecar.read({ owner: 'owner-1', tab: 'chat-0' }), { status: 'closed' });
      const again = await sidecar.open({ owner: 'owner-1', tab: 'chat-0', url: 'http://site-a.test/' });
      assert.equal(again.status, 'ok');
    });
  },
);

test(
  'only opening a page makes a tab, so a chat with none never closes another',
  { skip: !browsersAvailable },
  async () => {
    const { MAX_TABS_PER_PERSON } = await import('../src/server.mjs');
    await withWorld(async ({ sidecar }) => {
      const live = Array.from({ length: MAX_TABS_PER_PERSON }, (_, index) => `chat-${String(index)}`);
      for (const tab of live) {
        await sidecar.open({ owner: 'owner-1', tab, url: 'http://site-a.test/' });
      }
      for (const call of ['read', 'scroll', 'back', 'screenshot']) {
        assert.deepEqual(await sidecar[call]({ owner: 'owner-1', tab: 'chat-gone', direction: 'down' }), {
          status: 'closed',
        });
      }
      for (const tab of live) {
        assert.equal((await sidecar.read({ owner: 'owner-1', tab })).status, 'ok', tab);
      }
    });
  },
);

test('the sidecar will not start without its egress proxy', () => {
  if (BrowserSidecar === undefined) {
    return;
  }
  assert.throws(() => new BrowserSidecar({ profilesDir: '/tmp', navTimeoutMs: 1000 }), /egress proxy/);
});

test('two requests for one person launch one browser', async () => {
  if (BrowserSidecar === undefined) {
    return;
  }
  let launches = 0;
  const context = { on: () => undefined, route: async () => undefined, close: async () => undefined };
  const sidecar = new BrowserSidecar({
    profilesDir: '/tmp',
    navTimeoutMs: 1000,
    proxyServer: 'http://127.0.0.1:9',
    launch: async () => {
      launches += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { context, page: {} };
    },
  });
  const [a, b] = await Promise.all([sidecar.profileFor('owner-1'), sidecar.profileFor('owner-1')]);
  assert.equal(a, b);
  assert.equal(launches, 1);
});

test(
  'a profile lock left by an earlier container does not lock the person out',
  { skip: !browsersAvailable },
  async () => {
    const { mkdir, symlink } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    await withWorld(async ({ sidecar, profilesDir }) => {
      const dir = path.join(profilesDir, createHash('sha256').update('owner-1').digest('hex').slice(0, 32));
      await mkdir(dir, { recursive: true });
      await symlink('old-container-host-4242', path.join(dir, 'SingletonLock'));
      const result = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/' });
      assert.equal(result.status, 'ok');
    });
  },
);

/** The ref the snapshot text gave a line naming `label`, such as `[e3] button Place order`. */
function refFor(text, label) {
  const line = text.split('\n').find(candidate => candidate.includes(label));
  return /^\[(e\d+)\]/.exec(line ?? '')?.[1];
}

test('types into a field, then fills it', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Name on card');
    const typed = await sidecar.type({ owner: 'owner-1', tab: 'chat-1', ref, text: 'Grace Hopper' });
    assert.equal(typed.status, 'ok');
    assert.match(typed.text, /Grace Hopper/);
  });
});

test('refuses to type into a password field', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/' });
    const ref = refFor(opened.text, 'Password');
    const typed = await sidecar.type({ owner: 'owner-1', tab: 'chat-1', ref, text: 'hunter2' });
    assert.deepEqual(typed, { status: 'refused', reason: 'sensitive_field' });
  });
});

test('selects an option', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Country');
    const selected = await sidecar.select({ owner: 'owner-1', tab: 'chat-1', ref, option: 'United Kingdom' });
    assert.equal(selected.status, 'ok');
  });
});

test('click-info reads a submit button without clicking it', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Place order');
    const info = await sidecar.clickInfo({ owner: 'owner-1', tab: 'chat-1', ref });
    assert.equal(info.status, 'ok');
    assert.equal(info.is_form_submit, true);
    assert.equal(info.accessible_name, 'Place order');
    assert.equal(info.form_values.name, 'Ada Lovelace');
    // Nothing changed: the form is still there to click for real.
    const read = await sidecar.read({ owner: 'owner-1', tab: 'chat-1' });
    assert.match(read.text, /Place order/);
  });
});

test("click-info on a dialog's plain Cancel button is not a form submit", { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Cancel');
    const info = await sidecar.clickInfo({ owner: 'owner-1', tab: 'chat-1', ref });
    assert.equal(info.status, 'ok');
    assert.equal(info.is_form_submit, false);
  });
});

test('click-info reads a submit input from its value, which is its label', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/linked-controls' });
    const ref = refFor(opened.text, 'Pay now');
    const info = await sidecar.clickInfo({ owner: 'owner-1', tab: 'chat-1', ref });
    assert.equal(info.status, 'ok');
    assert.equal(info.accessible_name, 'Pay now');
    assert.equal(info.is_form_submit, true);
    assert.equal(info.form_values.item, 'Notebook');
  });
});

test(
  'click-info reads an image input as a form submit, named by its alt text',
  { skip: !browsersAvailable },
  async () => {
    await withWorld(async ({ sidecar }) => {
      const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/linked-controls' });
      const ref = refFor(opened.text, 'Buy with image');
      const info = await sidecar.clickInfo({ owner: 'owner-1', tab: 'chat-1', ref });
      assert.equal(info.status, 'ok');
      assert.equal(info.accessible_name, 'Buy with image');
      assert.equal(info.is_form_submit, true);
      assert.equal(info.form_values.item, 'Notebook');
    });
  },
);

test(
  "click-info reads a submit control outside its form, linked by the form attribute, with that form's values",
  { skip: !browsersAvailable },
  async () => {
    await withWorld(async ({ sidecar }) => {
      const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/linked-controls' });
      for (const label of ['Send order', 'Subscribe outside']) {
        const ref = refFor(opened.text, label);
        const info = await sidecar.clickInfo({ owner: 'owner-1', tab: 'chat-1', ref });
        assert.equal(info.status, 'ok', label);
        assert.equal(info.accessible_name, label, label);
        assert.equal(info.is_form_submit, true, label);
        assert.equal(info.form_values.item, 'Notebook', label);
      }
    });
  },
);

test('click performs a real click and reads the result', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Cancel');
    const clicked = await sidecar.click({ owner: 'owner-1', tab: 'chat-1', ref });
    assert.equal(clicked.status, 'ok');
    // The dialog's own script closed it; the page is otherwise unchanged.
    assert.match(clicked.text, /Checkout/);
  });
});

test('a ref resolves back to the DOM path it was given to, and an unknown ref resolves to nothing', async () => {
  const { RefAssigner } = await import('../src/snapshot.mjs');
  const refs = new RefAssigner();
  const given = refs.refsFor([
    { id: 'HTML:0/BUTTON:1', actionable: true },
    { id: 'HTML:0/P:0', actionable: false },
  ]);
  assert.equal(refs.resolve(given.get('HTML:0/BUTTON:1')), 'HTML:0/BUTTON:1');
  assert.equal(refs.resolve('e99'), undefined);
  refs.reset();
  assert.equal(refs.resolve('e1'), undefined);
});

/**
 * A sidecar on a fake page and a fake gateway check, with no Chromium: the one page has a single
 * field, given ref e1 by the opening read. `state` lets a test make that field vanish from the
 * page (`elementGone`, so its handle is gone) or unreadable once found (`infoReadable` false, so
 * the read of it comes back empty), which are the two different stale cases the actions refuse.
 */
async function withFakeSidecar(run) {
  if (BrowserSidecar === undefined) {
    return;
  }
  const gateway = createServer((_req, res) => {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, url: 'http://site-a.test/' }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const state = { elementGone: false, infoReadable: true };
  const element = { fill: async () => undefined, click: async () => undefined };
  const page = {
    url: () => 'http://site-a.test/',
    title: async () => 'Fake page',
    on: () => undefined,
    goto: async () => undefined,
    evaluate: async script => {
      if (typeof script === 'string' && script.includes('return extractSnapshotNodes()')) {
        return [{ id: 'HTML:0/INPUT:0', role: 'textbox', name: 'Name', value: '', field_kind: null, actionable: true }];
      }
      if (!state.infoReadable) {
        return null;
      }
      return { field_kind: null, is_form_submit: false, accessible_name: 'Name', form_values: {}, tag: 'INPUT' };
    },
    evaluateHandle: async () => ({ asElement: () => (state.elementGone ? null : element) }),
  };
  const context = {
    on: () => undefined,
    route: async () => undefined,
    newCDPSession: async () => ({
      on: () => undefined,
      send: async method => (method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : {}),
    }),
    close: async () => undefined,
  };
  const sidecar = new BrowserSidecar({
    profilesDir: '/tmp',
    navTimeoutMs: 1000,
    proxyServer: `http://127.0.0.1:${String(gateway.address().port)}`,
    launch: async () => ({ context, page }),
  });
  try {
    const opened = await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'http://site-a.test/' });
    assert.equal(opened.status, 'ok');
    await run({ sidecar, state });
  } finally {
    await sidecar.close();
    gateway.close();
  }
}

test('type with a ref the page never gave is refused as an unknown ref, with no browser', async () => {
  await withFakeSidecar(async ({ sidecar }) => {
    const typed = await sidecar.type({ owner: 'owner-1', tab: 'chat-1', ref: 'e99', text: 'hello' });
    assert.deepEqual(typed, { status: 'refused', reason: 'unknown_ref' });
  });
});

test('type with a ref whose element is gone from the page is refused as a stale ref, with no browser', async () => {
  await withFakeSidecar(async ({ sidecar, state }) => {
    state.elementGone = true;
    const typed = await sidecar.type({ owner: 'owner-1', tab: 'chat-1', ref: 'e1', text: 'hello' });
    assert.deepEqual(typed, { status: 'refused', reason: 'stale_ref' });
  });
});

test('type with a ref whose element can no longer be read is refused as a stale ref, with no browser', async () => {
  await withFakeSidecar(async ({ sidecar, state }) => {
    state.infoReadable = false;
    const typed = await sidecar.type({ owner: 'owner-1', tab: 'chat-1', ref: 'e1', text: 'hello' });
    assert.deepEqual(typed, { status: 'refused', reason: 'stale_ref' });
  });
});

/** A sidecar whose browser is a stand-in page, so the live view can be tested with no Chromium. */
async function fakeSidecar() {
  const acts = [];
  const handlers = {};
  let fileFields = 0;
  let launches = 0;
  const mainFrame = { name: 'main' };
  const page = {
    mainFrame: () => mainFrame,
    url: () => 'https://site-a.test/account',
    title: async () => 'Account',
    goto: async () => undefined,
    evaluate: async () => [],
    screenshot: async options => {
      acts.push({ screenshot: options });
      return Buffer.from('frame-bytes');
    },
    viewportSize: () => ({ width: 1280, height: 800 }),
    mouse: {
      click: async (x, y) => {
        acts.push({ click: [x, y] });
      },
      wheel: async (dx, dy) => {
        acts.push({ wheel: [dx, dy] });
      },
    },
    keyboard: {
      // Text that starts with "slow" takes a while, as a busy page can.
      type: async text => {
        if (text.startsWith('slow')) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        acts.push({ type: text });
      },
      press: async key => {
        acts.push({ key });
      },
    },
    on: (event, handler) => {
      handlers[event] = handler;
    },
    isClosed: () => false,
    // The page's file fields: none until a test gives it one.
    locator: selector => {
      assert.equal(selector, 'input[type="file"]');
      return {
        first: () => ({
          count: async () => fileFields,
          setInputFiles: async file => {
            acts.push({ fileField: file });
          },
        }),
      };
    },
    close: async () => undefined,
  };
  const cdp = {
    send: async method => (method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : {}),
    on: () => undefined,
  };
  const context = {
    on: () => undefined,
    route: async () => undefined,
    newPage: async () => page,
    newCDPSession: async () => cdp,
    close: async () => undefined,
  };
  // The gateway the sidecar asks before opening: every address is fine, and stays the address it was.
  const gateway = createServer((req, res) => {
    const asked = new URL(req.url, 'http://gateway.test');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: asked.searchParams.get('url') }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const sidecar = new BrowserSidecar({
    profilesDir: '/tmp',
    navTimeoutMs: 1000,
    proxyServer: `http://127.0.0.1:${gateway.address().port}`,
    launch: async () => {
      launches += 1;
      return { context, page };
    },
  });
  return {
    sidecar,
    acts,
    gateway,
    launches: () => launches,
    /** The page opens its file picker, as when its upload button is clicked; a stale one cannot take a file. */
    openFileChooser: ({ stale = false } = {}) => {
      handlers.filechooser({
        page: () => page,
        setFiles: async file => {
          if (stale) {
            throw new Error('Element is not attached to the DOM');
          }
          acts.push({ chooser: file });
        },
      });
    },
    /** The tab's page moves to another address on its site. */
    navigate: () => {
      handlers.framenavigated(mainFrame);
    },
    giveFileField: () => {
      fileFields = 1;
    },
  };
}

test('the live view lists, frames and drives a tab through a stand-in page', async () => {
  if (BrowserSidecar === undefined) {
    return;
  }
  const { sidecar, acts, gateway, launches } = await fakeSidecar();
  try {
    // No profile yet: an empty list, and nothing was launched to get it.
    assert.deepEqual(await sidecar.liveTabs({ owner: 'owner-1' }), { status: 'ok', tabs: [] });
    assert.equal(launches(), 0);

    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'https://site-a.test/account' });
    assert.deepEqual(await sidecar.liveTabs({ owner: 'owner-1' }), {
      status: 'ok',
      tabs: [{ tab: 'chat-1', title: 'Account', url: 'https://site-a.test/account' }],
    });

    const frame = await sidecar.liveFrame({ owner: 'owner-1', tab: 'chat-1' });
    assert.deepEqual(frame, {
      status: 'ok',
      jpeg_base64: Buffer.from('frame-bytes').toString('base64'),
      width: 1280,
      height: 800,
    });
    assert.deepEqual(acts.at(-1), { screenshot: { type: 'jpeg', quality: 60 } });

    // A click read from a frame half the viewport's size lands at twice the point on the page.
    assert.deepEqual(
      await sidecar.liveInput({
        owner: 'owner-1',
        tab: 'chat-1',
        input: { kind: 'click', x: 100, y: 50, imageWidth: 640, imageHeight: 400 },
      }),
      { status: 'ok' },
    );
    assert.deepEqual(acts.at(-1), { click: [200, 100] });

    await sidecar.liveInput({ owner: 'owner-1', tab: 'chat-1', input: { kind: 'type', text: '123456' } });
    assert.deepEqual(acts.at(-1), { type: '123456' });
    await sidecar.liveInput({ owner: 'owner-1', tab: 'chat-1', input: { kind: 'key', key: 'Enter' } });
    assert.deepEqual(acts.at(-1), { key: 'Enter' });
    await sidecar.liveInput({ owner: 'owner-1', tab: 'chat-1', input: { kind: 'wheel', dy: 240 } });
    assert.deepEqual(acts.at(-1), { wheel: [0, 240] });

    // A chat with no tab is closed to the live view, like it is to a read.
    assert.deepEqual(await sidecar.liveFrame({ owner: 'owner-1', tab: 'chat-9' }), { status: 'closed' });
    assert.deepEqual(
      await sidecar.liveInput({ owner: 'owner-1', tab: 'chat-9', input: { kind: 'key', key: 'Enter' } }),
      { status: 'closed' },
    );
  } finally {
    gateway.close();
    await sidecar.close();
  }
});

test('the live routes answer over HTTP, and listing them needs no tab', async () => {
  if (BrowserSidecar === undefined || createHttpServer === undefined) {
    return;
  }
  const { sidecar, gateway } = await fakeSidecar();
  const server = createHttpServer({ sidecar, allowedPeers: async () => ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (route, body) =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const tabs = await post('/live/tabs', { owner: 'owner-1' });
    assert.equal(tabs.status, 200);
    assert.deepEqual(await tabs.json(), { status: 'ok', tabs: [] });

    const frameWithNoTab = await post('/live/frame', { owner: 'owner-1' });
    assert.equal(frameWithNoTab.status, 400);

    const badInput = await post('/live/input', { owner: 'owner-1', tab: 'chat-1', kind: 'dance' });
    assert.equal(badInput.status, 200);
    assert.deepEqual(await badInput.json(), { status: 'bad_input' });
  } finally {
    server.close();
    gateway.close();
    await sidecar.close();
  }
});

test('the live view puts a file into the picker the page opened, else its file field, else says there is none', async () => {
  if (BrowserSidecar === undefined) {
    return;
  }
  const { sidecar, acts, gateway, openFileChooser, giveFileField, navigate } = await fakeSidecar();
  const file = { owner: 'owner-1', tab: 'chat-1', name: 'id.pdf', mime: 'application/pdf', data: 'JVBERi0=' };
  const expected = { name: 'id.pdf', mimeType: 'application/pdf', buffer: Buffer.from('JVBERi0=', 'base64') };
  try {
    assert.deepEqual(await sidecar.liveUpload(file), { status: 'closed' });
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'https://site-a.test/account' });

    assert.deepEqual(await sidecar.liveUpload(file), { status: 'no_file_field' });

    openFileChooser();
    assert.deepEqual(await sidecar.liveUpload(file), { status: 'ok' });
    assert.deepEqual(acts.at(-1), { chooser: expected });
    // A picker is filled once: the next upload goes to the page's file field, not the spent picker.
    giveFileField();
    assert.deepEqual(await sidecar.liveUpload(file), { status: 'ok' });
    assert.deepEqual(acts.at(-1), { fileField: expected });

    // A picker the page opened before it moved on is dropped; the file goes to the new page's field.
    openFileChooser();
    navigate();
    assert.deepEqual(await sidecar.liveUpload(file), { status: 'ok' });
    assert.deepEqual(acts.at(-1), { fileField: expected });
    // A picker that can no longer take the file falls back to the field too.
    openFileChooser({ stale: true });
    assert.deepEqual(await sidecar.liveUpload(file), { status: 'ok' });
    assert.deepEqual(acts.at(-1), { fileField: expected });

    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    assert.deepEqual(await sidecar.liveUpload({ ...file, data: tooBig }), { status: 'bad_input' });
  } finally {
    gateway.close();
    await sidecar.close();
  }
});

test('the live view runs acts sent at once in the order they were sent', async () => {
  if (BrowserSidecar === undefined) {
    return;
  }
  const { sidecar, acts, gateway } = await fakeSidecar();
  try {
    await sidecar.open({ owner: 'owner-1', tab: 'chat-1', url: 'https://site-a.test/account' });
    acts.length = 0;
    const send = input => sidecar.liveInput({ owner: 'owner-1', tab: 'chat-1', input });
    // The first key is slow to land; the ones after it still wait their turn.
    const answers = await Promise.all([
      send({ kind: 'click', x: 10, y: 10 }),
      send({ kind: 'type', text: 'slow-h' }),
      send({ kind: 'type', text: 'i' }),
      send({ kind: 'key', key: 'Enter' }),
    ]);
    assert.deepEqual(answers, Array(4).fill({ status: 'ok' }));
    assert.deepEqual(acts, [{ click: [10, 10] }, { type: 'slow-h' }, { type: 'i' }, { key: 'Enter' }]);
  } finally {
    gateway.close();
    await sidecar.close();
  }
});
