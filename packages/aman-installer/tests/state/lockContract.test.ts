import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { folderBackend } from '../../src/state/folderBackend.ts';
import { withFolderLock } from '../../src/state/folderLock.ts';
import type { LockTiming } from '../../src/state/lockTiming.ts';
import { createStateStore, parseRegistry, StateBusyError } from '../../src/state/state.ts';

// The shell installer and the folder lock both follow the contract in
// installer/STATE.md ("The lock"). Each test has one of them hold the
// lock for longer than the dead limit and checks the other stays out.

const COMMON_SH = new URL('../../../../installer/lib/common.sh', import.meta.url).pathname;
const FAST: LockTiming = { beatSeconds: 1, deadSeconds: 3 };
const ONE_INSTANCE = { name: 'main', entries: parseRegistry('name=main\n') };

const SHELL_PRELUDE =
  '. "$1"; STATE_DIR=$2/state; die() { printf "%s\\n" "$*" >&2; exit 1; }; LOCK_BEAT_SECONDS=1; LOCK_DEAD_SECONDS=3;';

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

async function freshHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aman-lock-contract-'));
}

function shellHolder(home: string): Promise<number | null> {
  const child = spawn('bash', ['-c', `${SHELL_PRELUDE} lock_acquire; sleep 7; lock_release`, '_', COMMON_SH, home], {
    stdio: 'ignore',
  });
  return new Promise(resolve => {
    child.on('close', resolve);
  });
}

function shellTries(home: string) {
  return spawnSync('bash', ['-c', `${SHELL_PRELUDE} lock_acquire; lock_release`, '_', COMMON_SH, home]);
}

test('a long shell install keeps the folder writer out', async () => {
  const home = await freshHome();
  const holder = shellHolder(home);
  await pause(5000);
  const store = createStateStore(folderBackend(home, FAST));
  await assert.rejects(store.writeInstance(ONE_INSTANCE), (error: unknown) => error instanceof StateBusyError);
  assert.equal(await holder, 0);
});

test('a long folder write keeps the shell installer out', async () => {
  const home = await freshHome();
  await withFolderLock({
    home,
    timing: FAST,
    run: async () => {
      await pause(5000);
      const result = shellTries(home);
      assert.equal(result.status, 1, result.stdout.toString());
    },
  });
});
