import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ownNetworks } from '../account.mjs';
import { checkSignIn, discoverCalendarServer, sameProvider } from '../signin.mjs';
import {
  ACCOUNT_ID,
  BASE_HOST,
  HOME_HOST,
  homeProp,
  multistatus,
  OTHER_HOST,
  PASSWORD,
  principalProp,
  PUBLIC_ADDRESS,
  startFakeCalDav,
} from './fake-caldav.mjs';

describe('the sign-in walk when the calendars live on another host', () => {
  let fake;

  before(async () => {
    fake = await startFakeCalDav();
  });

  after(() => fake.close());

  beforeEach(() => fake.reset());

  const onBase = homeHref => path =>
    path === '/'
      ? multistatus({ href: '/', props: principalProp(`/${ACCOUNT_ID}/principal/`) })
      : multistatus({ href: path, props: homeProp(homeHref) });

  it('starts the tool server on the home set once its host passes the address rules', async () => {
    const found = await discoverCalendarServer(fake.account(), fake.deps);
    assert.deepEqual(found, { result: 'ok', server_url: `${fake.url(HOME_HOST)}/${ACCOUNT_ID}/calendars/` });
    assert.deepEqual(fake.looked, [BASE_HOST, HOME_HOST]);
    // The second host is walked the way the tool server will walk it: its first address, then the principal.
    assert.deepEqual(
      fake.seen.filter(request => request.host === HOME_HOST).map(request => request.path),
      [`/${ACCOUNT_ID}/calendars/`, `/${ACCOUNT_ID}/principal/`],
    );
    assert.ok(fake.seen.every(request => request.method === 'PROPFIND' && request.depth === '0'));
  });

  it('connects to the addresses the rules checked, not to a second lookup', async () => {
    await discoverCalendarServer(fake.account(), {
      ...fake.deps,
      // Even a lookup passed in with the connection settings cannot replace the checked one.
      tls: { ...fake.deps.tls, lookup: () => assert.fail('the passed-in lookup was used') },
    });
    assert.ok(fake.connected.length >= 4);
    assert.ok(fake.connected.every(entry => entry.addresses.length === 1 && entry.addresses[0] === PUBLIC_ADDRESS));
  });

  it('keeps the saved address when the principal and the home set are on its own host', async () => {
    fake.answers[BASE_HOST] = onBase(`/${ACCOUNT_ID}/calendars/`);
    const found = await discoverCalendarServer(fake.account(), fake.deps);
    assert.deepEqual(found, { result: 'ok', server_url: fake.account().url });
    assert.deepEqual(fake.looked, [BASE_HOST]);
    assert.ok(fake.seen.every(request => request.host === BASE_HOST));
  });

  it('never sends the login to a principal on another host', async () => {
    fake.answers[BASE_HOST] = path =>
      multistatus({ href: path, props: principalProp(`${fake.url(HOME_HOST)}/${ACCOUNT_ID}/principal/`) });
    assert.deepEqual(await discoverCalendarServer(fake.account(), fake.deps), { result: 'server' });
    assert.deepEqual(fake.looked, [BASE_HOST]);
    assert.ok(fake.seen.every(request => request.host === BASE_HOST));
  });

  it('refuses a home set on a host of another provider, before any lookup or connection', async () => {
    for (const href of [
      `https://calendars.elsewhere.invalid/${ACCOUNT_ID}/calendars/`,
      `https://cloud.example.invalid.elsewhere.example/${ACCOUNT_ID}/calendars/`,
      `https://${PUBLIC_ADDRESS}/${ACCOUNT_ID}/calendars/`,
    ]) {
      fake.reset();
      fake.answers[BASE_HOST] = onBase(href);
      assert.deepEqual(await discoverCalendarServer(fake.account(), fake.deps), { result: 'server' }, href);
      assert.deepEqual(fake.looked, [BASE_HOST], href);
    }
  });

  it('refuses a home host on the never list before any connection is made to it', async () => {
    for (const address of ['169.254.169.254', '127.0.0.1', '10.0.0.1']) {
      fake.reset();
      const found = await discoverCalendarServer(fake.account(), {
        ...fake.deps,
        // 10.x stands for this service's own Compose network here.
        ownNetworks:
          address === '10.0.0.1'
            ? ownNetworks({ eth0: [{ address: '10.0.0.2', cidr: '10.0.0.2/24', family: 'IPv4' }] })
            : fake.deps.ownNetworks,
        resolve: async name => (name === HOME_HOST ? [address] : [PUBLIC_ADDRESS]),
      });
      assert.deepEqual(found, { result: 'blocked' }, address);
      assert.ok(!fake.seen.some(request => request.host === HOME_HOST), address);
    }
  });

  it('refuses a home set that is not https or carries a name and password', async () => {
    for (const href of [
      `http://${HOME_HOST}:${fake.ports[HOME_HOST]}/${ACCOUNT_ID}/calendars/`,
      `https://someone:secret@${HOME_HOST}:${fake.ports[HOME_HOST]}/${ACCOUNT_ID}/calendars/`,
    ]) {
      fake.reset();
      fake.answers[BASE_HOST] = onBase(href);
      assert.deepEqual(await discoverCalendarServer(fake.account(), fake.deps), { result: 'server' }, href);
      assert.ok(!fake.seen.some(request => request.host === HOME_HOST), href);
    }
  });

  it('refuses home sets spread over two other hosts, since the tool server talks to one host only', async () => {
    fake.answers[BASE_HOST] = path =>
      path === '/'
        ? multistatus({ href: '/', props: principalProp(`/${ACCOUNT_ID}/principal/`) })
        : multistatus({
            href: path,
            props: homeProp(
              `${fake.url(HOME_HOST)}/${ACCOUNT_ID}/calendars/`,
              `${fake.url(OTHER_HOST)}/${ACCOUNT_ID}/tasks/`,
            ),
          });
    assert.deepEqual(await discoverCalendarServer(fake.account(), fake.deps), { result: 'server' });
    assert.ok(fake.seen.every(request => request.host === BASE_HOST));
  });

  it('refuses a home host that points on to a third host, rather than following it', async () => {
    fake.answers[HOME_HOST] = path =>
      multistatus({
        href: path,
        props:
          path === `/${ACCOUNT_ID}/calendars/`
            ? principalProp(`/${ACCOUNT_ID}/principal/`)
            : homeProp(`${fake.url(OTHER_HOST)}/${ACCOUNT_ID}/calendars/`),
      });
    assert.deepEqual(await discoverCalendarServer(fake.account(), fake.deps), { result: 'server' });
    assert.ok(!fake.seen.some(request => request.host === OTHER_HOST));
  });

  it('reports a login the home host refuses, and a home host that cannot be reached', async () => {
    assert.equal(await checkSignIn({ ...fake.account(), password: 'CANARY-WRONG' }, fake.deps), 'login');
    fake.answers[HOME_HOST] = () => undefined;
    assert.equal(await checkSignIn(fake.account(), fake.deps), 'server');
  });

  it('gives up once the whole walk runs out of time, even on a server that keeps trickling', async () => {
    const timers = [];
    fake.answers[BASE_HOST] = (_path, res) => {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      timers.push(setInterval(() => res.write(' '), 20));
      return 'handled';
    };
    const began = Date.now();
    const result = await checkSignIn(fake.account(), { ...fake.deps, timeoutMs: 10_000, walkTimeoutMs: 300 });
    for (const timer of timers) {
      clearInterval(timer);
    }
    assert.equal(result, 'server');
    assert.ok(Date.now() - began < 5_000);
  });

  it('never echoes the password in its answer', async () => {
    const found = await discoverCalendarServer(fake.account(), fake.deps);
    assert.ok(!JSON.stringify(found).includes(PASSWORD));
  });
});

describe('which other hosts count as the same provider', () => {
  it('accepts hosts of one registered domain and nothing else', () => {
    assert.ok(sameProvider({ saved: 'caldav.icloud.com', other: 'caldav.icloud.com' }));
    assert.ok(sameProvider({ saved: 'caldav.icloud.com', other: 'p42-caldav.icloud.com' }));
    assert.ok(sameProvider({ saved: 'dav.mail.example.org', other: 'eu.example.org' }));
    assert.ok(!sameProvider({ saved: 'caldav.icloud.com', other: 'icloud.com.attacker.example' }));
    assert.ok(!sameProvider({ saved: 'caldav.icloud.com', other: 'evilicloud.com' }));
    assert.ok(!sameProvider({ saved: 'caldav.icloud.com', other: 'calendar.example.org' }));
    // Two customers of one domain ending, public or handed out by a hosting service, are not one provider.
    assert.ok(!sameProvider({ saved: 'example.co.uk', other: 'attacker.co.uk' }));
    assert.ok(!sameProvider({ saved: 'caldav.example.co.uk', other: 'attacker.co.uk' }));
    assert.ok(!sameProvider({ saved: 'mycal.duckdns.org', other: 'evil.duckdns.org' }));
    assert.ok(!sameProvider({ saved: 'mine.herokuapp.com', other: 'theirs.herokuapp.com' }));
    // An address written as a number has no domain.
    assert.ok(!sameProvider({ saved: '203.0.113.10', other: '203.0.113.11' }));
  });
});
