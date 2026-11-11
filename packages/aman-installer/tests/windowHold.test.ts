import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldHoldWindow } from '../src/windowHold.ts';

function jobs(fromExplorer: boolean): { startedFromExplorer: () => Promise<boolean> } {
  return { startedFromExplorer: () => Promise.resolve(fromExplorer) };
}

const BASE = { hostKind: 'windows', interactive: true, command: 'doctor', exitCode: 0, parentPid: 42 };

test('a window Explorer opened waits for Enter, success or not', async () => {
  assert.equal(await shouldHoldWindow({ ...BASE, jobs: jobs(true) }), true);
  assert.equal(await shouldHoldWindow({ ...BASE, exitCode: 1, jobs: jobs(true) }), true);
  assert.equal(await shouldHoldWindow({ ...BASE, command: undefined, jobs: jobs(true) }), true);
});

test('a terminal, a scheduled task or another system never waits', async () => {
  assert.equal(await shouldHoldWindow({ ...BASE, jobs: jobs(false) }), false);
  assert.equal(await shouldHoldWindow({ ...BASE, interactive: false, jobs: jobs(true) }), false);
  assert.equal(await shouldHoldWindow({ ...BASE, hostKind: 'darwin', jobs: jobs(true) }), false);
});

test('opening Aman closes its window when it worked, and holds it when it did not', async () => {
  assert.equal(await shouldHoldWindow({ ...BASE, command: 'open', jobs: jobs(true) }), false);
  assert.equal(await shouldHoldWindow({ ...BASE, command: 'open', exitCode: 1, jobs: jobs(true) }), true);
});
