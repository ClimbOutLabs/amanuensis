// Exercises the sidecar against a small fixture page served from this test, with a real Chromium.
// Needs Playwright's browsers installed (`npx playwright install --with-deps chromium`), which the
// Docker image already has; skipped automatically where they are not, so `npm test` on a plain
// checkout still runs the rest of the suite.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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

async function withFixtureServer(run) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(FIXTURE_HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${String(port)}/`);
  } finally {
    server.close();
  }
}

test('reads a fixture page: title, links, and a masked password field', { skip: !browsersAvailable }, async () => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), 'browser-sidecar-'));
  const sidecar = new BrowserSidecar({ profilesDir, navTimeoutMs: 10_000 });
  try {
    await withFixtureServer(async url => {
      const result = await sidecar.open({ owner: 'owner-1', url });
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
