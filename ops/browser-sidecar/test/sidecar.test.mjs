// Exercises the sidecar in a real, headed, sandboxed Chromium, with every request going through the
// real egress proxy. Only DNS and the proxy's final TCP connect are stood in for: two made-up public
// sites, site-a.test and site-b.test, are served from local fixture servers, and a third fixture
// stands in for everything private (Aman's own server, the metadata address, the home network).
//
// Needs a Chromium for this Playwright release, a display (run under xvfb-run, as the image does) and
// a user that may use the Chromium sandbox (not root). Skipped where any of these is missing, so
// `npm test` on a plain checkout still runs the rest of the suite. Set BROWSER_CHROMIUM_PATH to use a
// Chromium installed somewhere else.
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
} catch {
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
    // A button whose label matches no commit word and which is not a form submit, the case the Tier
    // classifier can miss, but whose click handler quietly posts to the same site with JavaScript.
    '/newsletter': html(
      `<h1>Newsletter</h1><button type="button" id="continue-button" onclick="fetch('/subscribe', { method: 'POST' })">Continue</button>`,
    ),
    '/article': html(
      `<h1>Article</h1><button type="button" id="share-button" onclick="fetch('http://site-b.test/beacon', { method: 'POST' }).catch(() => {})">Share</button>`,
    ),
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
    '*': html('<h1>Other page</h1>'),
  });

  const names = { 'site-a.test': [SITE_A], 'site-b.test': [SITE_B], 'rebind.test': ['10.0.0.8'] };
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
    resolve: async name => names[name] ?? [],
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
      const result = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/' });
      assert.equal(result.status, 'ok');
      assert.match(result.text, /Streaming Account/);
      assert.match(result.text, /Cancel membership/);
      assert.doesNotMatch(result.text, /current-password/);
      assert.match(result.text, /\[hidden: password field\]/);
    });
  },
);

test('refuses to open a private address before the browser is touched', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, internalUrl, internal }) => {
    const result = await sidecar.open({ owner: 'owner-1', url: `${internalUrl}/` });
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
      const result = await sidecar.open({ owner: 'owner-1', url: `http://site-a.test${route}` });
      assert.equal(result.status, 'moved');
      assert.deepEqual(internal.hits, []);
    });
  });
}

test("a page's own requests to private addresses never reach them", { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, internal }) => {
    const result = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/fetch-private' });
    assert.equal(result.status, 'ok');
    await settle();
    assert.deepEqual(internal.hits, []);
  });
});

test('a page cannot move its own tab to another site', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/leave' });
    await settle();
    assert.deepEqual(siteB.hits, []);
    const read = await sidecar.read({ owner: 'owner-1' });
    assert.equal(read.status, 'ok');
    assert.match(read.text, /Leaving/);
  });
});

test('a page cannot submit a form to another site', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/post-away' });
    await settle();
    assert.deepEqual(siteB.hits, []);
  });
});

test('a page cannot open a window of its own', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/popup' });
    await settle();
    assert.deepEqual(siteB.hits, []);
  });
});

test('a page may still move around its own site', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/same-site-nav' });
    await settle();
    const read = await sidecar.read({ owner: 'owner-1' });
    assert.equal(read.status, 'ok');
    assert.match(read.text, /Streaming Account/);
  });
});

test(
  'a redirect to another site is not read; opening that site is a new open',
  { skip: !browsersAvailable },
  async () => {
    await withWorld(async ({ sidecar }) => {
      const moved = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/redirect-site-b' });
      assert.deepEqual(moved, { status: 'moved', url: 'http://site-b.test/inbox' });
      assert.equal((await sidecar.read({ owner: 'owner-1' })).status, 'moved');
      assert.equal((await sidecar.screenshot({ owner: 'owner-1' })).status, 'moved');
      const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-b.test/inbox' });
      assert.equal(opened.status, 'ok');
      assert.match(opened.text, /Mail inbox/);
    });
  },
);

test('going back to another site is not read', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/' });
    await sidecar.open({ owner: 'owner-1', url: 'http://site-b.test/inbox' });
    const back = await sidecar.back({ owner: 'owner-1' });
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
  assert.throws(() => createHttpServer({ sidecar, secret: 'short' }), /at least 32/);
  const server = createHttpServer({ sidecar, secret: 'k'.repeat(40) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${String(server.address().port)}/read`;
    const post = secret =>
      fetch(url, { method: 'POST', headers: { 'x-browser-secret': secret }, body: JSON.stringify({ owner: 'o' }) });
    assert.equal((await post('k'.repeat(39))).status, 401);
    assert.equal((await post('k'.repeat(40))).status, 200);
  } finally {
    server.close();
  }
});

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
  const [a, b] = await Promise.all([sidecar.sessionFor('owner-1'), sidecar.sessionFor('owner-1')]);
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
      const result = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/' });
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
    const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Name on card');
    const typed = await sidecar.type({ owner: 'owner-1', ref, text: 'Grace Hopper' });
    assert.equal(typed.status, 'ok');
    assert.match(typed.text, /Grace Hopper/);
  });
});

test('refuses to type into a password field', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/' });
    const ref = refFor(opened.text, 'Password');
    const typed = await sidecar.type({ owner: 'owner-1', ref, text: 'hunter2' });
    assert.deepEqual(typed, { status: 'refused', reason: 'sensitive_field' });
  });
});

test('selects an option', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Country');
    const selected = await sidecar.select({ owner: 'owner-1', ref, option: 'United Kingdom' });
    assert.equal(selected.status, 'ok');
  });
});

test('click-info reads a submit button without clicking it', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Place order');
    const info = await sidecar.clickInfo({ owner: 'owner-1', ref });
    assert.equal(info.status, 'ok');
    assert.equal(info.is_form_submit, true);
    assert.equal(info.accessible_name, 'Place order');
    assert.equal(info.form_values.name, 'Ada Lovelace');
    // Nothing changed: the form is still there to click for real.
    const read = await sidecar.read({ owner: 'owner-1' });
    assert.match(read.text, /Place order/);
  });
});

test("click-info on a dialog's plain Cancel button is not a form submit", { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Cancel');
    const info = await sidecar.clickInfo({ owner: 'owner-1', ref });
    assert.equal(info.status, 'ok');
    assert.equal(info.is_form_submit, false);
  });
});

test('click performs a real click and reads the result', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar }) => {
    const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/checkout' });
    const ref = refFor(opened.text, 'Cancel');
    const clicked = await sidecar.click({ owner: 'owner-1', ref });
    assert.equal(clicked.status, 'ok');
    // The dialog's own script closed it; the page is otherwise unchanged.
    assert.match(clicked.text, /Checkout/);
  });
});

test(
  'an unapproved click whose label hides a same-site post is caught and needs approval',
  { skip: !browsersAvailable },
  async () => {
    await withWorld(async ({ sidecar, siteA }) => {
      const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/newsletter' });
      const ref = refFor(opened.text, 'Continue');
      // No `approved` flag: the classifier found no commit word on "Continue", so the host
      // dispatches this click right away, exactly as it would any other Tier 1 click.
      const clicked = await sidecar.click({ owner: 'owner-1', ref });
      assert.equal(clicked.status, 'needs_approval');
      assert.equal(clicked.accessible_name, 'Continue');
      assert.ok(clicked.png_base64, 'a screenshot is returned with the hold');
      // The post was aborted in the browser: the site never saw it.
      assert.deepEqual(
        siteA.hits.filter(hit => hit.url === '/subscribe'),
        [],
      );
    });
  },
);

test('an approved click is trusted outright: the gate is not run', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteA }) => {
    const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/newsletter' });
    const ref = refFor(opened.text, 'Continue');
    const clicked = await sidecar.click({ owner: 'owner-1', ref, approved: true });
    assert.equal(clicked.status, 'ok');
    assert.ok(
      siteA.hits.some(hit => hit.url === '/subscribe' && hit.method === 'POST'),
      'the approved post went through',
    );
  });
});

test('a third-party request during a click is allowed, not blocked', { skip: !browsersAvailable }, async () => {
  await withWorld(async ({ sidecar, siteB }) => {
    const opened = await sidecar.open({ owner: 'owner-1', url: 'http://site-a.test/article' });
    const ref = refFor(opened.text, 'Share');
    const clicked = await sidecar.click({ owner: 'owner-1', ref });
    // The beacon's host (site-b.test) differs from the page's own site (site-a.test): never gated.
    assert.equal(clicked.status, 'ok');
    assert.ok(
      siteB.hits.some(hit => hit.url === '/beacon'),
      'the third-party beacon went through',
    );
  });
});
