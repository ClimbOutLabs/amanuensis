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
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

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
    '*': html('<h1>Other page</h1>'),
  });

  const names = {
    'site-a.test': [SITE_A],
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
      const other = await sidecar.read({ owner: 'owner-1', tab: 'chat-2' });
      assert.equal(other.status, 'ok');
      assert.doesNotMatch(other.text, /Mail inbox/);
      await sidecar.open({ owner: 'owner-1', tab: 'chat-2', url: 'http://site-a.test/' });
      const first = await sidecar.read({ owner: 'owner-1', tab: 'chat-1' });
      assert.equal(first.status, 'ok');
      assert.match(first.text, /Mail inbox/);
    });
  },
);

test(
  'a person keeps a limited number of tabs; the one used longest ago closes',
  { skip: !browsersAvailable },
  async () => {
    const { MAX_TABS_PER_PERSON } = await import('../src/server.mjs');
    await withWorld(async ({ sidecar }) => {
      await sidecar.open({ owner: 'owner-1', tab: 'chat-0', url: 'http://site-b.test/inbox' });
      for (let index = 1; index <= MAX_TABS_PER_PERSON; index += 1) {
        await sidecar.read({ owner: 'owner-1', tab: `chat-${String(index)}` });
      }
      const reopened = await sidecar.read({ owner: 'owner-1', tab: 'chat-0' });
      assert.doesNotMatch(reopened.text, /Mail inbox/);
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

test('Chromium does not get the shared secret', { skip: BrowserSidecar === undefined }, async () => {
  const { browserEnv } = await import('../src/server.mjs');
  const env = browserEnv({ BROWSER_SECRET: 's'.repeat(40), PATH: '/usr/bin', DISPLAY: ':99', HOME: '/home/pwuser' });
  assert.deepEqual(env, { DISPLAY: ':99', HOME: '/home/pwuser', PATH: '/usr/bin' });
});

test('the API refuses a short secret and a wrong one', { skip: BrowserSidecar === undefined }, async () => {
  const sidecar = { read: async () => ({ status: 'ok', text: '' }) };
  const allowedPeers = async () => ['127.0.0.1'];
  assert.throws(() => createHttpServer({ sidecar, secret: 'short', allowedPeers }), /at least 32/);
  const server = createHttpServer({ sidecar, secret: 'k'.repeat(40), allowedPeers });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${String(server.address().port)}/read`;
    const post = (secret, body = { owner: 'o', tab: 't' }) =>
      fetch(url, { method: 'POST', headers: { 'x-browser-secret': secret }, body: JSON.stringify(body) });
    assert.equal((await post('k'.repeat(39))).status, 401);
    assert.equal((await post('k'.repeat(40))).status, 200);
    assert.equal((await post('k'.repeat(40), { owner: 'o' })).status, 400);
  } finally {
    server.close();
  }
});

test(
  'the API answers only the gateway, even with the right secret',
  { skip: BrowserSidecar === undefined },
  async () => {
    let reads = 0;
    const sidecar = {
      read: async () => {
        reads += 1;
        return { status: 'ok', text: '' };
      },
    };
    const secret = 'k'.repeat(40);
    assert.throws(() => createHttpServer({ sidecar, secret }), /gateway/);
    // The gateway is somewhere else; this test, like Chromium inside the container, calls from loopback.
    const server = createHttpServer({ sidecar, secret, allowedPeers: async () => ['172.30.0.2'] });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.address().port)}/read`, {
        method: 'POST',
        headers: { 'x-browser-secret': secret },
        body: JSON.stringify({ owner: 'o', tab: 't' }),
      });
      assert.equal(response.status, 403);
      assert.equal(reads, 0);
    } finally {
      server.close();
    }
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
