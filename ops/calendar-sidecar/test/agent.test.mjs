import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ownNetworks, renderAccount } from '../account.mjs';
import { createAgent, createAgentServer, MIN_SECRET_LENGTH, runCommand } from '../agent.mjs';

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
const SECRET = 'test-account-secret-0123456789abcdef0123';
const WRONG = 'CANARY-WRONG-PASSWORD-9z';
const HOST = 'caldav.example.invalid';
const USERNAME = 'owner@example.invalid';
const PUBLIC_ADDRESS = '93.184.216.34';

describe('the calendar account agent', () => {
  let folder;
  let file;
  let calendarServer;
  let calendarPort;
  let seen;
  let behavior;
  let deps;
  let agent;
  let listener;
  let listenerPort;
  let tlsCert;

  const payload = (overrides = {}) => ({
    url: `https://${HOST}:${calendarPort}/dav/`,
    username: USERNAME,
    password: CANARY,
    email: USERNAME,
    ...overrides,
  });

  before(async () => {
    folder = mkdtempSync(join(tmpdir(), 'calendar-agent-'));
    const key = join(folder, 'key.pem');
    const cert = join(folder, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${HOST}`,
        '-addext',
        `subjectAltName=DNS:${HOST}`,
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    tlsCert = readFileSync(cert);
    calendarServer = createHttpsServer({ key: readFileSync(key), cert: tlsCert }, (req, res) => {
      seen.push({ method: req.method, authorization: req.headers.authorization, url: req.url });
      if (behavior === 'slash' && !req.url.endsWith('/')) {
        res.writeHead(301, { Location: `${req.url}/` });
        res.end();
        return;
      }
      if (behavior === 'redirect') {
        res.writeHead(302, { Location: 'https://other.example.invalid/' });
        res.end('redirect echoing ' + (req.headers.authorization ?? ''));
        return;
      }
      const expected = `Basic ${Buffer.from(`${USERNAME}:${CANARY}`).toString('base64')}`;
      if (req.headers.authorization === expected) {
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end('<d:multistatus xmlns:d="DAV:"/>');
      } else {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
        res.end('wrong login ' + (req.headers.authorization ?? ''));
      }
    });
    await new Promise(done => calendarServer.listen(0, '127.0.0.1', done));
    calendarPort = calendarServer.address().port;
  });

  after(() => {
    listener?.closeAllConnections();
    listener?.close();
    calendarServer.closeAllConnections();
    calendarServer.close();
    rmSync(folder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    seen = [];
    behavior = 'normal';
    file = join(folder, `account-${Math.random().toString(16).slice(2)}.env`);
    deps = {
      resolve: async () => [PUBLIC_ADDRESS],
      ownNetworks: ownNetworks({}),
      // The fake server stands behind the checked address; only the trusted certificate and the route differ.
      tls: {
        ca: tlsCert,
        lookup: (_name, options, callback) =>
          options?.all === true
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4),
      },
    };
    agent = createAgent({ file, deps });
    listener?.closeAllConnections();
    listener?.close();
    listener = createAgentServer({ agent, secret: SECRET });
    await new Promise(done => listener.listen(0, '127.0.0.1', done));
    listenerPort = listener.address().port;
  });

  async function call(method, body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${listenerPort}/account`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  }

  it('checks the sign-in first, then saves a private file, and answers without the password', async () => {
    const saved = await call('POST', payload());
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.text), {
      connected: true,
      url: payload().url,
      username: USERNAME,
      email: USERNAME,
      sign_in: 'ok',
    });
    assert.ok(!saved.text.includes(CANARY));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(readFileSync(file, 'utf8').includes(`CALDAV_PASSWORD=${CANARY}`));
    assert.equal(seen[0].method, 'PROPFIND');
    const status = await call('GET');
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.text).sign_in, 'ok');
    assert.ok(!status.text.includes(CANARY));
  });

  it('saves nothing when the server refuses the login, and never repeats what the server said', async () => {
    const refused = await call('POST', payload({ password: WRONG }));
    assert.equal(refused.status, 400);
    assert.deepEqual(JSON.parse(refused.text), { error: 'sign_in_refused' });
    assert.ok(!refused.text.includes(WRONG));
    assert.equal(existsSync(file), false);
  });

  it('saves nothing when the server cannot be reached', async () => {
    const unreachable = await call('POST', payload({ url: `https://${HOST}:1/dav/` }));
    assert.equal(unreachable.status, 400);
    assert.deepEqual(JSON.parse(unreachable.text), { error: 'server_unreachable' });
    assert.equal(existsSync(file), false);
  });

  it('does not follow a redirect with the login', async () => {
    behavior = 'redirect';
    const redirected = await call('POST', payload());
    assert.deepEqual(JSON.parse(redirected.text), { error: 'redirected' });
    assert.equal(seen.length, 1);
    assert.ok(!redirected.text.includes(CANARY));
    assert.equal(existsSync(file), false);
  });

  it('follows one redirect to another path on the same server, such as a trailing slash', async () => {
    behavior = 'slash';
    const saved = await call('POST', payload({ url: `https://${HOST}:${calendarPort}/dav` }));
    assert.equal(saved.status, 200);
    assert.deepEqual(
      seen.map(request => request.url),
      ['/dav', '/dav/'],
    );
  });

  it('names a certificate it does not trust, and sends nothing after the handshake fails', async () => {
    deps.tls = { lookup: deps.tls.lookup };
    const refused = await call('POST', payload());
    assert.deepEqual(JSON.parse(refused.text), { error: 'certificate_refused' });
    assert.equal(seen.length, 0);
    assert.equal(existsSync(file), false);
  });

  it('refuses an address on the never list before any connection is made', async () => {
    for (const address of ['169.254.169.254', '127.0.0.1', '::1', 'fe80::1']) {
      deps.resolve = async () => [address];
      const blocked = await call('POST', payload());
      assert.equal(blocked.status, 400, address);
      assert.deepEqual(JSON.parse(blocked.text), { error: 'address_not_allowed' });
    }
    assert.equal(seen.length, 0);
    assert.equal(existsSync(file), false);
  });

  it('refuses a request that could write a second setting into the file', async () => {
    for (const [bad, field] of [
      [{ url: `https://${HOST}/\nCALDAV_PASSWORD=x` }, 'url'],
      [{ username: 'a\nCALDAV_URL=x' }, 'username'],
      [{ password: 'one\ntwo' }, 'password'],
      [{ password: ' padded' }, 'password'],
      [{ url: 'http://caldav.example.invalid/' }, 'url'],
      [{ email: 'nope' }, 'email'],
      [{ email: 'a\u0001b@example.invalid' }, 'email'],
    ]) {
      const invalid = await call('POST', payload(bad));
      assert.deepEqual(JSON.parse(invalid.text), { error: 'invalid', field }, JSON.stringify(bad));
    }
    assert.equal((await call('POST', undefined)).status, 400);
    assert.equal(existsSync(file), false);
  });

  it('removes the account for good', async () => {
    await call('POST', payload());
    const removed = await call('DELETE');
    assert.deepEqual(JSON.parse(removed.text), { connected: false });
    assert.equal(existsSync(file), false);
    assert.deepEqual(JSON.parse((await call('GET')).text), { connected: false });
    assert.deepEqual(JSON.parse((await call('DELETE')).text), { connected: false });
  });

  it('reports a saved login the server no longer accepts', async () => {
    writeFileSync(file, renderAccount({ ...payload(), password: WRONG }), { mode: 0o600 });
    assert.equal(JSON.parse((await call('GET')).text).sign_in, 'refused');
  });

  it('answers only a caller that presents the secret, and says nothing else without it', async () => {
    await call('POST', payload());
    for (const headers of [{ authorization: '' }, { authorization: 'Bearer wrong' }, { authorization: SECRET }]) {
      for (const method of ['GET', 'DELETE']) {
        const refused = await call(method, undefined, headers);
        assert.equal(refused.status, 401, `${method} ${JSON.stringify(headers)}`);
        assert.deepEqual(JSON.parse(refused.text), { error: 'unauthorized' });
      }
      assert.equal((await call('POST', payload(), headers)).status, 401);
    }
    const noHeader = await fetch(`http://127.0.0.1:${listenerPort}/account`);
    assert.equal(noHeader.status, 401);
    assert.equal(existsSync(file), true, 'a refused delete must leave the account in place');
  });

  it('refuses a save whose body is not declared as JSON', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const response = await call('POST', payload(), { 'content-type': type });
      assert.equal(response.status, 415, type);
    }
    assert.equal(existsSync(file), false);
    const withCharset = await call('POST', payload(), { 'content-type': 'application/json; charset=utf-8' });
    assert.equal(withCharset.status, 200);
  });

  it('will not start without a secret long enough to guard the port', () => {
    assert.throws(() => createAgentServer({ agent, secret: undefined }));
    assert.throws(() => createAgentServer({ agent, secret: 'x'.repeat(MIN_SECRET_LENGTH - 1) }));
  });

  it('only answers requests addressed to the service name, and only on /account', async () => {
    const plain = ({ path, method = 'GET', host = 'calendar-caldav' }) =>
      new Promise((done, failed) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: listenerPort,
            path,
            method,
            headers: { Host: host, Authorization: `Bearer ${SECRET}` },
          },
          res => {
            res.resume();
            res.on('end', () => done(res.statusCode));
          },
        );
        req.on('error', failed);
        req.end();
      });
    assert.equal(await plain({ path: '/account', host: 'attacker.example.invalid' }), 403);
    assert.equal(await plain({ path: '/account', host: 'calendar-caldav:9560' }), 200);
    assert.equal(await plain({ path: '/other' }), 404);
    assert.equal(await plain({ path: '/account', method: 'PUT' }), 405);
  });
});

describe('the installer commands', () => {
  let folder;
  let file;
  const out = {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
  const err = {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
  const resolveTo = address => ({ resolve: async () => [address], ownNetworks: ownNetworks({}) });
  const installerText = (url = 'https://caldav.example.invalid/dav/') =>
    `CALDAV_URL=${url}\nCALDAV_USERNAME=${USERNAME}\nCALDAV_PASSWORD=${CANARY}\nCALDAV_USER_EMAIL=${USERNAME}\n`;
  const run = (command, stdinText, deps) => runCommand({ command, file, stdin: async () => stdinText, deps, out, err });

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'calendar-cli-'));
    file = join(folder, '.env.calendar');
    out.text = '';
    err.text = '';
  });

  after(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('saves the account text from stdin as a private file and prints one word', async () => {
    assert.equal(await run('--write-stdin', installerText(), resolveTo(PUBLIC_ADDRESS)), 0);
    assert.equal(out.text, 'saved\n');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(readFileSync(file, 'utf8').includes(`CALDAV_PASSWORD=${CANARY}`));
    assert.ok(!out.text.includes(CANARY) && !err.text.includes(CANARY));
  });

  it('refuses incomplete text and an address on the never list, and prints no password', async () => {
    assert.equal(
      await run('--write-stdin', 'CALDAV_URL=https://caldav.example.invalid/\n', resolveTo(PUBLIC_ADDRESS)),
      2,
    );
    assert.equal(await run('--write-stdin', '', resolveTo(PUBLIC_ADDRESS)), 2);
    assert.equal(await run('--write-stdin', installerText(), resolveTo('169.254.169.254')), 3);
    assert.equal(await run('--write-stdin', installerText('https://169.254.169.254/dav/'), undefined), 3);
    assert.equal(existsSync(file), false);
    assert.ok(!err.text.includes(CANARY));
  });

  it('removes the account and says none is saved afterwards', async () => {
    await run('--write-stdin', installerText(), resolveTo(PUBLIC_ADDRESS));
    out.text = '';
    assert.equal(await run('--remove'), 0);
    assert.equal(out.text, 'removed\n');
    assert.equal(existsSync(file), false);
    out.text = '';
    assert.equal(await run('--check'), 0);
    assert.equal(out.text, 'none\n');
  });
});
