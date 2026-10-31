// Exercises the sidecar against a small fixture page served from this test, with a real Chromium.
// Needs Playwright's browsers installed (`npx playwright install --with-deps chromium`), which the
// Docker image already has; skipped automatically where they are not, so `npm test` on a plain
// checkout still runs the rest of the suite.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// playwright-core, and the Chromium build it drives, are a devDependency of the real sidecar image;
// a plain checkout of this repo (no `npm install` here, no browsers installed) still runs the rest
// of the suite, so the import itself, not only launching a browser, is inside this try.
let BrowserSidecar;
let browsersAvailable = true;
try {
  ({ BrowserSidecar } = await import('../src/server.mjs'));
  const { chromium } = await import('playwright-core');
  const probe = await chromium.launch({ headless: true });
  await probe.close();
} catch {
  browsersAvailable = false;
}

const FIXTURE_HTML = `<!doctype html>
<html>
  <body>
    <h1>Streaming Account</h1>
    <p>Manage your plan below.</p>
    <a href="/help">Help center</a>
    <a href="/cancel">Cancel membership</a>
    <form>
      <label for="pw">Password</label>
      <input id="pw" type="password" autocomplete="current-password" />
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>`;

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

// A button whose label matches no commit word and which is not a form submit — the case the Tier
// classifier can miss — but whose click handler quietly posts to the same site with JavaScript.
const DISGUISED_FIXTURE_HTML = `<!doctype html>
<html>
  <body>
    <h1>Newsletter</h1>
    <button type="button" id="continue-button" onclick="fetch('/subscribe', { method: 'POST' })">Continue</button>
  </body>
</html>`;

async function withFixtureServer(run, html = FIXTURE_HTML) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${String(port)}/`);
  } finally {
    server.close();
  }
}

/**
 * Loads a fixture page directly on the owner's session, bypassing the public `open()` gate: a test
 * fixture necessarily runs on this computer, which `open()` (correctly) refuses to navigate to, so
 * every test below that only needs a page loaded uses this instead. `open()`'s own refusal is
 * covered on its own, against an address nothing here needs to serve.
 */
async function openFixture(sidecar, owner, url) {
  const session = await sidecar.sessionFor(owner);
  session.refs.reset();
  await session.page.goto(url, { waitUntil: 'domcontentloaded' });
  return sidecar.read({ owner });
}

test('reads a fixture page: title, links, and a masked password field', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    await withFixtureServer(async url => {
      const result = await openFixture(sidecar, 'owner-1', url);
      assert.equal(result.status, 'ok');
      assert.match(result.text, /Streaming Account/);
      assert.match(result.text, /Cancel membership/);
      assert.doesNotMatch(result.text, /current-password/);
      assert.match(result.text, /\[hidden: password field\]/);
    });
  } finally {
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('refuses to open a private address', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    const result = await sidecar.open({ owner: 'owner-1', url: 'http://127.0.0.1:1/' });
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'private_network');
  } finally {
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

/** The ref the snapshot text gave a line naming `label`, such as `[e3] button Place order`. */
function refFor(text, label) {
  const line = text.split('\n').find(candidate => candidate.includes(label));
  return /^\[(e\d+)\]/.exec(line ?? '')?.[1];
}

test('types into a field, then fills it', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    await withFixtureServer(async url => {
      const opened = await openFixture(sidecar, 'owner-1', url);
      const ref = refFor(opened.text, 'Name on card');
      const typed = await sidecar.type({ owner: 'owner-1', ref, text: 'Grace Hopper' });
      assert.equal(typed.status, 'ok');
      assert.match(typed.text, /Grace Hopper/);
    }, CHECKOUT_FIXTURE_HTML);
  } finally {
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('refuses to type into a password field', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    await withFixtureServer(async url => {
      const opened = await openFixture(sidecar, 'owner-1', url);
      const ref = refFor(opened.text, 'Password');
      const typed = await sidecar.type({ owner: 'owner-1', ref, text: 'hunter2' });
      assert.deepEqual(typed, { status: 'refused', reason: 'sensitive_field' });
    });
  } finally {
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('selects an option', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    await withFixtureServer(async url => {
      const opened = await openFixture(sidecar, 'owner-1', url);
      const ref = refFor(opened.text, 'Country');
      const selected = await sidecar.select({ owner: 'owner-1', ref, option: 'United Kingdom' });
      assert.equal(selected.status, 'ok');
    }, CHECKOUT_FIXTURE_HTML);
  } finally {
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('click-info reads a submit button without clicking it', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    await withFixtureServer(async url => {
      const opened = await openFixture(sidecar, 'owner-1', url);
      const ref = refFor(opened.text, 'Place order');
      const info = await sidecar.clickInfo({ owner: 'owner-1', ref });
      assert.equal(info.status, 'ok');
      assert.equal(info.is_form_submit, true);
      assert.equal(info.accessible_name, 'Place order');
      assert.equal(info.form_values.name, 'Ada Lovelace');
      assert.ok(info.png_base64, 'a screenshot comes with the dry run, for the approval card');
      // Nothing changed: the form is still there to click for real.
      const read = await sidecar.read({ owner: 'owner-1' });
      assert.match(read.text, /Place order/);
    }, CHECKOUT_FIXTURE_HTML);
  } finally {
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test("click-info on a dialog's plain Cancel button is not a form submit", { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    await withFixtureServer(async url => {
      const opened = await openFixture(sidecar, 'owner-1', url);
      const ref = refFor(opened.text, 'Cancel');
      const info = await sidecar.clickInfo({ owner: 'owner-1', ref });
      assert.equal(info.status, 'ok');
      assert.equal(info.is_form_submit, false);
    }, CHECKOUT_FIXTURE_HTML);
  } finally {
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('click performs a real click and reads the result', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    await withFixtureServer(async url => {
      const opened = await openFixture(sidecar, 'owner-1', url);
      const ref = refFor(opened.text, 'Cancel');
      const clicked = await sidecar.click({ owner: 'owner-1', ref });
      assert.equal(clicked.status, 'ok');
      // The dialog's own script closed it; the page is otherwise unchanged.
      assert.match(clicked.text, /Checkout/);
    }, CHECKOUT_FIXTURE_HTML);
  } finally {
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test(
  'an unapproved click whose label hides a same-site post is caught and needs approval',
  { skip: !browsersAvailable },
  async () => {
    const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
    const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
    try {
      await withFixtureServer(async url => {
        const opened = await openFixture(sidecar, 'owner-1', url);
        const ref = refFor(opened.text, 'Continue');
        // No `approved` flag: the classifier found no commit word on "Continue", so the host
        // dispatches this click right away, exactly as it would any other Tier 1 click.
        const clicked = await sidecar.click({ owner: 'owner-1', ref });
        assert.equal(clicked.status, 'needs_approval');
        assert.equal(clicked.accessible_name, 'Continue');
        assert.ok(clicked.png_base64, 'a screenshot is returned with the hold');
      }, DISGUISED_FIXTURE_HTML);
    } finally {
      await sidecar.close();
      await rm(profilesDir, { recursive: true, force: true });
    }
  },
);

test('an approved click is trusted outright: the gate is not run', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    await withFixtureServer(async url => {
      const opened = await openFixture(sidecar, 'owner-1', url);
      const ref = refFor(opened.text, 'Continue');
      const clicked = await sidecar.click({ owner: 'owner-1', ref, approved: true });
      assert.equal(clicked.status, 'ok');
    }, DISGUISED_FIXTURE_HTML);
  } finally {
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});

test('a third-party request during a click is allowed, not blocked', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  // Two different hostnames on loopback (127.0.0.1 and localhost) stand in for the page's own site
  // and a third-party analytics host: different enough for the gate's same-site check, reachable
  // without any real network or DNS setup.
  let beaconReached = false;
  const beaconServer = createServer((_req, res) => {
    beaconReached = true;
    res.writeHead(200).end();
  });
  try {
    await new Promise(resolve => beaconServer.listen(0, 'localhost', resolve));
    const { port: beaconPort } = beaconServer.address();
    const html = `<!doctype html>
<html><body>
  <h1>Article</h1>
  <button type="button" id="share-button" onclick="fetch('http://localhost:${String(beaconPort)}/beacon', { method: 'POST' }).catch(() => {})">Share</button>
</body></html>`;
    await withFixtureServer(async url => {
      const opened = await openFixture(sidecar, 'owner-1', url);
      const ref = refFor(opened.text, 'Share');
      const clicked = await sidecar.click({ owner: 'owner-1', ref });
      // The beacon's host (localhost) differs from the page's own site (127.0.0.1): never gated.
      assert.equal(clicked.status, 'ok');
      assert.equal(beaconReached, true);
    }, html);
  } finally {
    beaconServer.close();
    await sidecar.close();
    await rm(profilesDir, { recursive: true, force: true });
  }
});
