import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { renderAccount } from '../account.mjs';
import { DISCOVERY_RETRY_MS, gatewayCommand, startSupervisor } from '../entrypoint.mjs';
import { ACCOUNT_ID, HOME_HOST, PASSWORD, PUBLIC_ADDRESS, startFakeCalDav } from './fake-caldav.mjs';

describe('the tool server command', () => {
  it('loads the address guard into the tool server', () => {
    const [, args] = gatewayCommand({ host: '127.0.0.1', port: 9558 });
    const stdio = args[args.indexOf('--stdio') + 1];
    assert.match(stdio, /^node --import '[^']+\/connect-guard\.mjs' '[^']+\/@ni-c\/caldav-mcp\/dist\/index\.js'$/);
  });
});

describe('the supervisor', () => {
  let fake;
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

  const homeUrl = () => `${fake.url(HOME_HOST)}/${ACCOUNT_ID}/calendars/`;

  const supervise = overrides => {
    supervisor = startSupervisor({
      file,
      host: '127.0.0.1',
      port: 0,
      deps: { ...fake.deps, spawn: fakeSpawn, now: () => clock, ...overrides },
    });
    return supervisor;
  };

  before(async () => {
    fake = await startFakeCalDav();
  });

  after(() => fake.close());

  beforeEach(() => {
    fake.reset();
    file = join(fake.folder, `account-${Math.random().toString(16).slice(2)}.env`);
    writeFileSync(file, renderAccount(fake.account()), { mode: 0o600 });
    started = [];
    clock = 1_000_000;
  });

  it('starts on the saved address, then moves the tool server to the home host the walk checked', async () => {
    supervise();
    await supervisor.settled();
    supervisor.stop();
    assert.deepEqual(
      started.map(child => child.env.CALDAV_URL),
      [fake.account().url, homeUrl()],
    );
    assert.equal(started[0].signalCode, 'SIGTERM');
    assert.equal(started.at(-1).env.CALDAV_PASSWORD, PASSWORD);
    assert.equal(started.at(-1).env.CALENDAR_ACCOUNT_SECRET, undefined);
  });

  it('stays on the saved address while the walk fails, and asks again only after a growing wait', async () => {
    fake.answers[HOME_HOST] = () => undefined;
    supervise();
    await supervisor.settled();
    const askedOnce = fake.seen.length;
    await supervisor.tick();
    await supervisor.settled();
    assert.equal(fake.seen.length, askedOnce, 'no second walk before the wait is over');
    clock += DISCOVERY_RETRY_MS.first;
    await supervisor.tick();
    await supervisor.settled();
    supervisor.stop();
    assert.ok(fake.seen.length > askedOnce);
    assert.deepEqual(
      started.map(child => child.env.CALDAV_URL),
      [fake.account().url],
    );
  });

  it('never starts the tool server for a saved address on the never list', async () => {
    supervise({ resolve: async () => ['169.254.169.254'] });
    await supervisor.settled();
    supervisor.stop();
    assert.equal(started.length, 0);
    assert.equal(fake.seen.length, 0);
  });

  it('checks the home host again when it starts there, and does not start on it once it is refused', async () => {
    let homeLookups = 0;
    supervise({
      resolve: async name => {
        if (name === HOME_HOST && ++homeLookups > 1) {
          return ['169.254.169.254'];
        }
        return [PUBLIC_ADDRESS];
      },
    });
    await supervisor.settled();
    supervisor.stop();
    assert.equal(homeLookups, 2, 'the walk looked it up once and the start once more');
    assert.deepEqual(
      started.map(child => child.env.CALDAV_URL),
      [fake.account().url],
    );
    assert.equal(started[0].signalCode, 'SIGTERM');
  });

  it('keeps following the file while a walk is slow, and never brings a removed account back', async () => {
    let release;
    const held = new Promise(done => {
      release = done;
    });
    supervise({
      resolve: async name => {
        if (name === HOME_HOST) {
          await held;
        }
        return [PUBLIC_ADDRESS];
      },
    });
    await supervisor.tick();
    assert.deepEqual(
      started.map(child => child.env.CALDAV_URL),
      [fake.account().url],
    );
    rmSync(file);
    // The round is not held up by the walk still waiting on the home host.
    await supervisor.tick();
    assert.equal(started[0].signalCode, 'SIGTERM');
    release();
    await supervisor.settled();
    supervisor.stop();
    assert.equal(started.length, 1, 'nothing started after the account was removed');
  });
});
