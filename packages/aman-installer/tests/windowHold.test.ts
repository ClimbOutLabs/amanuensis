import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldHoldWindow } from '../src/windowHold.ts';

function jobs(ownsConsole: boolean): { ownsItsConsole: () => Promise<boolean>; asked: () => number } {
  let asked = 0;
  return {
    ownsItsConsole: () => {
      asked += 1;
      return Promise.resolve(ownsConsole);
    },
    asked: () => asked,
  };
}

const BASE = { hostKind: 'windows', interactive: true, command: 'doctor', exitCode: 0, selfPid: 42 };

test('a window this program has to itself waits for Enter, success or not', async () => {
  assert.equal(await shouldHoldWindow({ ...BASE, jobs: jobs(true) }), true);
  assert.equal(await shouldHoldWindow({ ...BASE, exitCode: 1, jobs: jobs(true) }), true);
  assert.equal(await shouldHoldWindow({ ...BASE, command: undefined, jobs: jobs(true) }), true);
  assert.equal(await shouldHoldWindow({ ...BASE, command: 'setup', jobs: jobs(true) }), true);
});

test('a terminal, a pipe or another system never waits', async () => {
  assert.equal(await shouldHoldWindow({ ...BASE, jobs: jobs(false) }), false);
  assert.equal(await shouldHoldWindow({ ...BASE, interactive: false, jobs: jobs(true) }), false);
  assert.equal(await shouldHoldWindow({ ...BASE, hostKind: 'darwin', jobs: jobs(true) }), false);
});

test('the daily backup task never waits, even in a window of its own', async () => {
  const probe = jobs(true);
  assert.equal(await shouldHoldWindow({ ...BASE, command: 'backup', jobs: probe }), false);
  assert.equal(await shouldHoldWindow({ ...BASE, command: 'backup', exitCode: 1, jobs: probe }), false);
  assert.equal(probe.asked(), 0);
});

test('opening Aman closes its window when it worked, and holds it when it did not', async () => {
  assert.equal(await shouldHoldWindow({ ...BASE, command: 'open', jobs: jobs(true) }), false);
  assert.equal(await shouldHoldWindow({ ...BASE, command: 'open', exitCode: 1, jobs: jobs(true) }), true);
});

test('the console is asked about this program, by its own process id', async () => {
  let seen = 0;
  const probe = {
    ownsItsConsole: (pid: number) => {
      seen = pid;
      return Promise.resolve(true);
    },
  };
  assert.equal(await shouldHoldWindow({ ...BASE, selfPid: 4711, jobs: probe }), true);
  assert.equal(seen, 4711);
});
