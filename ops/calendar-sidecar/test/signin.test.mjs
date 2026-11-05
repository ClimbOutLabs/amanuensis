import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ownNetworks, renderAccount } from '../account.mjs';
import { DISCOVERY_RETRY_MS, startSupervisor } from '../entrypoint.mjs';
import { checkSignIn, discoverCalendarServer } from '../signin.mjs';

// Shaped like iCloud: the saved address names the principal on its own host, and the principal names a
// calendar home on a second host. The second host answers for the same account on its own name.
const BASE_HOST = 'caldav.cloud.example.invalid';
const HOME_HOST = 'p42-caldav.cloud.example.invalid';
const OTHER_HOST = 'p43-caldav.cloud.example.invalid';
const PUBLIC_ADDRESS = '93.184.216.34';
const ACCOUNT_ID = '1234567';
const PASSWORD = 'CANARY-APP-SPECIFIC-PASSWORD';
const USER = 'person@icloud.example.invalid';

const multistatus = ({ href, props }) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response>' +
  `<href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat>` +
  '</response></multistatus>';
const principalProp = href => `<current-user-principal><href>${href}</href></current-user-principal>`;
const homeProp = (...hrefs) =>
  `<C:calendar-home-set>${hrefs.map(href => `<href>${href}</href>`).join('')}</C:calendar-home-set>`;

describe('the sign-in walk when the calendars live on another host', () => {
  let folder;
  let tlsCert;
  let tlsKey;
  let base;
  let home;
  let other;
  let seen;
  let looked;
  let answers;
  let deps;

  const url = name => `https://${name}:${{ [BASE_HOST]: base, [HOME_HOST]: home, [OTHER_HOST]: other }[name].port}`;
  const account = () => ({ url: `${url(BASE_HOST)}/`, username: USER, password: PASSWORD, email: USER });

  function fakeHost(name) {
    const server = createHttpsServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
      seen.push({ host: name, method: req.method, path: req.url, depth: req.headers.depth });
      const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401);
        res.end();
        return;
      }
      const body = answers[name]?.(req.url);
      if (body === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(body);
    });
    return new Promise(done => server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port })));
  }

  before(async () => {
    folder = mkdtempSync(join(tmpdir(), 'calendar-signin-'));
    const keyFile = join(folder, 'key.pem');
    const certFile = join(folder, 'cert.pem');
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
        `/CN=${BASE_HOST}`,
        '-addext',
        `subjectAltName=DNS:${BASE_HOST},DNS:${HOME_HOST},DNS:${OTHER_HOST}`,
        '-keyout',
        keyFile,
        '-out',
        certFile,
      ],
      { stdio: 'ignore' },
    );
    tlsKey = readFileSync(keyFile);
    tlsCert = readFileSync(certFile);
    base = await fakeHost(BASE_HOST);
    home = await fakeHost(HOME_HOST);
    other = await fakeHost(OTHER_HOST);
  });

  after(() => {
    for (const host of [base, home, other]) {
      host.server.closeAllConnections();
      host.server.close();
    }
    rmSync(folder, { recursive: true, force: true });
  });

  beforeEach(() => {
    seen = [];
    looked = [];
    // The iCloud shape: a relative principal on the saved host, and a home set on the second host, written
    // with the default port the way Apple writes it (here the fake server's own port).
    answers = {
      [BASE_HOST]: path => {
        if (path === '/') {
          return multistatus({ href: '/', props: principalProp(`/${ACCOUNT_ID}/principal/`) });
        }
        if (path === `/${ACCOUNT_ID}/principal/`) {
          return multistatus({ href: path, props: homeProp(`${url(HOME_HOST)}/${ACCOUNT_ID}/calendars/`) });
        }
        return undefined;
      },
      [HOME_HOST]: path => {
        if (path === `/${ACCOUNT_ID}/calendars/`) {
          return multistatus({ href: path, props: principalProp(`/${ACCOUNT_ID}/principal/`) });
        }
        if (path === `/${ACCOUNT_ID}/principal/`) {
          return multistatus({ href: path, props: homeProp(`${url(HOME_HOST)}/${ACCOUNT_ID}/calendars/`) });
        }
        return undefined;
      },
    };
    deps = {
      resolve: async name => {
        looked.push(name);
        return [PUBLIC_ADDRESS];
      },
      ownNetworks: ownNetworks({}),
      // The fake servers stand behind the checked address; only the trusted certificate and the route differ.
      tls: {
        ca: tlsCert,
        lookup: (_name, options, callback) =>
          options?.all === true
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4),
      },
    };
  });

  it('starts the tool server on the home set once its host passes the address rules', async () => {
    const found = await discoverCalendarServer(account(), deps);
    assert.deepEqual(found, { result: 'ok', server_url: `${url(HOME_HOST)}/${ACCOUNT_ID}/calendars/` });
    assert.deepEqual(looked, [BASE_HOST, HOME_HOST]);
    // The second host is walked the way the tool server will walk it: its first address, then the principal.
    assert.deepEqual(
      seen.filter(request => request.host === HOME_HOST).map(request => request.path),
      [`/${ACCOUNT_ID}/calendars/`, `/${ACCOUNT_ID}/principal/`],
    );
    assert.ok(seen.every(request => request.method === 'PROPFIND' && request.depth === '0'));
  });

  it('keeps the saved address when the principal and the home set are on its own host', async () => {
    answers[BASE_HOST] = path =>
      path === '/'
        ? multistatus({ href: '/', props: principalProp(`/${ACCOUNT_ID}/principal/`) })
        : multistatus({ href: path, props: homeProp(`/${ACCOUNT_ID}/calendars/`) });
    const found = await discoverCalendarServer(account(), deps);
    assert.deepEqual(found, { result: 'ok', server_url: account().url });
    assert.deepEqual(looked, [BASE_HOST]);
    assert.ok(seen.every(request => request.host === BASE_HOST));
  });

  it('refuses a home host on the never list before any connection is made to it', async () => {
    for (const address of ['169.254.169.254', '127.0.0.1', '10.0.0.1']) {
      seen = [];
      const ownRange = address === '10.0.0.1';
      const found = await discoverCalendarServer(account(), {
        ...deps,
        // 10.x stands for this service's own Compose network here.
        ownNetworks: ownRange
          ? ownNetworks({ eth0: [{ address: '10.0.0.2', cidr: '10.0.0.2/24', family: 'IPv4' }] })
          : deps.ownNetworks,
        resolve: async name => (name === HOME_HOST ? [address] : [PUBLIC_ADDRESS]),
      });
      assert.deepEqual(found, { result: 'blocked' }, address);
      assert.ok(!seen.some(request => request.host === HOME_HOST), address);
    }
  });

  it('refuses a home set that is not https or carries a name and password', async () => {
    for (const href of [
      `http://${HOME_HOST}:${home.port}/${ACCOUNT_ID}/calendars/`,
      `https://someone:secret@${HOME_HOST}:${home.port}/${ACCOUNT_ID}/calendars/`,
    ]) {
      seen = [];
      answers[BASE_HOST] = path =>
        path === '/'
          ? multistatus({ href: '/', props: principalProp(`/${ACCOUNT_ID}/principal/`) })
          : multistatus({ href: path, props: homeProp(href) });
      assert.deepEqual(await discoverCalendarServer(account(), deps), { result: 'server' }, href);
      assert.ok(!seen.some(request => request.host === HOME_HOST), href);
    }
  });

  it('refuses home sets spread over two other hosts, since the tool server talks to one host only', async () => {
    answers[BASE_HOST] = path =>
      path === '/'
        ? multistatus({ href: '/', props: principalProp(`/${ACCOUNT_ID}/principal/`) })
        : multistatus({
            href: path,
            props: homeProp(`${url(HOME_HOST)}/${ACCOUNT_ID}/calendars/`, `${url(OTHER_HOST)}/${ACCOUNT_ID}/tasks/`),
          });
    assert.deepEqual(await discoverCalendarServer(account(), deps), { result: 'server' });
    assert.ok(seen.every(request => request.host === BASE_HOST));
  });

  it('refuses a home host that points on to a third host, rather than following it', async () => {
    answers[HOME_HOST] = path =>
      multistatus({
        href: path,
        props:
          path === `/${ACCOUNT_ID}/calendars/`
            ? principalProp(`/${ACCOUNT_ID}/principal/`)
            : homeProp(`${url(OTHER_HOST)}/${ACCOUNT_ID}/calendars/`),
      });
    assert.deepEqual(await discoverCalendarServer(account(), deps), { result: 'server' });
    assert.ok(!seen.some(request => request.host === OTHER_HOST));
  });

  it('reports a login the home host refuses, and a home host that cannot be reached', async () => {
    assert.equal(await checkSignIn({ ...account(), password: 'CANARY-WRONG' }, deps), 'login');
    answers[HOME_HOST] = () => undefined;
    assert.equal(await checkSignIn(account(), deps), 'server');
  });

  describe('the supervisor', () => {
    let file;
    let started;
    let clock;
    let supervisor;

    const fakeSpawn = (_command, _args, options) => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        env: options.env,
        kill() {
          child.signalCode = 'SIGTERM';
        },
      });
      started.push(child);
      return child;
    };

    beforeEach(() => {
      file = join(folder, `account-${Math.random().toString(16).slice(2)}.env`);
      writeFileSync(file, renderAccount(account()), { mode: 0o600 });
      started = [];
      clock = 1_000_000;
    });

    const supervise = overrides => {
      supervisor = startSupervisor({
        file,
        host: '127.0.0.1',
        port: 0,
        deps: { ...deps, spawn: fakeSpawn, now: () => clock, ...overrides },
      });
      return supervisor;
    };

    it('starts on the saved address, then moves the tool server to the home host the walk checked', async () => {
      supervise();
      await supervisor.tick();
      supervisor.stop();
      assert.deepEqual(
        started.map(child => child.env.CALDAV_URL),
        [account().url, `${url(HOME_HOST)}/${ACCOUNT_ID}/calendars/`],
      );
      assert.equal(started[0].signalCode, 'SIGTERM');
      assert.equal(started.at(-1).env.CALDAV_PASSWORD, PASSWORD);
      assert.equal(started.at(-1).env.CALENDAR_ACCOUNT_SECRET, undefined);
    });

    it('stays on the saved address while the walk fails, and asks again only after a growing wait', async () => {
      answers[HOME_HOST] = () => undefined;
      supervise();
      await supervisor.tick();
      const askedOnce = seen.length;
      await supervisor.tick();
      assert.equal(seen.length, askedOnce, 'no second walk before the wait is over');
      clock += DISCOVERY_RETRY_MS.first;
      await supervisor.tick();
      supervisor.stop();
      assert.ok(seen.length > askedOnce);
      assert.deepEqual(
        started.map(child => child.env.CALDAV_URL),
        [account().url],
      );
    });

    it('never starts the tool server for a saved address on the never list', async () => {
      supervise({ resolve: async () => ['169.254.169.254'] });
      await supervisor.tick();
      supervisor.stop();
      assert.equal(started.length, 0);
      assert.equal(seen.length, 0);
    });
  });
});
