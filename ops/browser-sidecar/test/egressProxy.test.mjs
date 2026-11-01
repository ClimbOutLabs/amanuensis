import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';

import { createEgressProxy } from '../src/egressProxy.mjs';

/** A plain upstream web server standing in for a public site. */
async function upstream() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      proxyAuth: req.headers['proxy-authorization'],
    });
    res.writeHead(200, { 'content-type': 'text/plain' }).end('hello from upstream');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, port: server.address().port };
}

/**
 * The proxy under test, with DNS answered from `names` and the final TCP connect sent to the local
 * upstream. Every dial is recorded, so a test can see exactly which address the proxy connected to.
 */
async function proxyWith({ names, upstreamPort }) {
  const dials = [];
  const lookups = [];
  const proxy = createEgressProxy({
    resolve: async name => {
      lookups.push(name);
      const answer = names[name];
      if (answer === undefined) {
        throw new Error('ENOTFOUND');
      }
      return typeof answer === 'function' ? answer() : answer;
    },
    dial: ({ host, port }) => {
      dials.push({ host, port });
      return connect({ host: '127.0.0.1', port: upstreamPort });
    },
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { proxy, dials, lookups, port: proxy.address().port };
}

function connectThrough(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on('response', res => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
}

function getThrough(proxyPort, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers });
    req.on('response', res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withProxy(names, run) {
  const up = await upstream();
  const p = await proxyWith({ names, upstreamPort: up.port });
  try {
    await run({ ...p, seen: up.seen });
  } finally {
    p.proxy.close();
    up.server.close();
  }
}

test('CONNECT to a public name dials the address that was checked', async () => {
  await withProxy({ 'site.test': ['93.184.216.34'] }, async ({ port, dials }) => {
    assert.equal(await connectThrough(port, 'site.test:443'), 200);
    assert.deepEqual(dials, [{ host: '93.184.216.34', port: 443 }]);
  });
});

for (const [label, authority, names] of [
  ['a loopback address', '127.0.0.1:8790', {}],
  ['the cloud metadata address', '169.254.169.254:80', {}],
  ['an IPv4-mapped IPv6 loopback', '[::ffff:127.0.0.1]:8790', {}],
  ['IPv6 loopback', '[::1]:8790', {}],
  ['localhost', 'localhost:8790', { localhost: ['93.184.216.34'] }],
  ['a name that resolves to a private address', 'internal.test:443', { 'internal.test': ['10.0.0.7'] }],
  [
    'a name with one private answer among public ones',
    'mixed.test:443',
    { 'mixed.test': ['93.184.216.34', '192.168.1.1'] },
  ],
  ['a name that resolves to a mapped loopback', 'mapped.test:443', { 'mapped.test': ['::ffff:7f00:1'] }],
  ['a name that does not resolve', 'nowhere.test:443', {}],
]) {
  test(`CONNECT refuses ${label} and never dials`, async () => {
    await withProxy(names, async ({ port, dials }) => {
      assert.equal(await connectThrough(port, authority), 403);
      assert.deepEqual(dials, []);
    });
  });
}

test('a plain http request is forwarded to the checked address with its own Host, without proxy headers', async () => {
  await withProxy({ 'site.test': ['93.184.216.34'] }, async ({ port, dials, seen }) => {
    const result = await getThrough(port, 'http://site.test/page?q=1', { 'proxy-authorization': 'Basic x' });
    assert.equal(result.status, 200);
    assert.equal(result.body, 'hello from upstream');
    assert.deepEqual(dials, [{ host: '93.184.216.34', port: 80 }]);
    assert.deepEqual(seen, [{ method: 'GET', url: '/page?q=1', host: 'site.test', proxyAuth: undefined }]);
  });
});

test('a plain http request to a private address is refused and never sent', async () => {
  await withProxy({ 'internal.test': ['172.17.0.1'] }, async ({ port, dials, seen }) => {
    assert.equal((await getThrough(port, 'http://internal.test:8790/api/admin')).status, 403);
    assert.equal((await getThrough(port, 'http://127.0.0.1:8790/api/admin')).status, 403);
    assert.deepEqual(dials, []);
    assert.deepEqual(seen, []);
  });
});

test('a name that changes its answer is looked up once per request, and the checked answer is the one dialed', async () => {
  let calls = 0;
  const rebinding = () => (++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
  await withProxy({ 'rebind.test': rebinding }, async ({ port, dials, lookups }) => {
    assert.equal(await connectThrough(port, 'rebind.test:443'), 200);
    assert.deepEqual(dials, [{ host: '93.184.216.34', port: 443 }]);
    // The next request sees the new, private answer and is refused.
    assert.equal(await connectThrough(port, 'rebind.test:443'), 403);
    assert.deepEqual(dials, [{ host: '93.184.216.34', port: 443 }]);
    assert.deepEqual(lookups, ['rebind.test', 'rebind.test']);
  });
});

test('a request that is neither an absolute http URL nor the address check is not answered', async () => {
  await withProxy({}, async ({ port, dials }) => {
    assert.equal((await getThrough(port, '/relative')).status, 404);
    assert.deepEqual(dials, []);
  });
});

test('the address check answers by the same rules, and never connects anywhere', async () => {
  const names = { 'site.test': ['93.184.216.34'], 'internal.test': ['10.0.0.8'] };
  await withProxy(names, async ({ port, dials }) => {
    const check = async url => {
      const response = await fetch(`http://127.0.0.1:${String(port)}/check?url=${encodeURIComponent(url)}`);
      return response.json();
    };
    assert.deepEqual(await check('http://site.test/a?b=1'), { ok: true, url: 'http://site.test/a?b=1' });
    assert.deepEqual(await check('https://internal.test/'), { ok: false, reason: 'private_network' });
    assert.deepEqual(await check('http://169.254.169.254/'), { ok: false, reason: 'private_network' });
    assert.deepEqual(await check('http://nowhere.test/'), { ok: false, reason: 'unresolved' });
    assert.deepEqual(await check('file:///etc/passwd'), { ok: false, reason: 'scheme' });
    assert.deepEqual(await check('not a url'), { ok: false, reason: 'not_a_url' });
    assert.deepEqual(dials, []);
  });
});
