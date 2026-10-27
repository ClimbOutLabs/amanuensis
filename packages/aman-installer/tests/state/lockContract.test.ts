import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { folderBackend } from '../../src/state/folderBackend.ts';
import { withFolderLock } from '../../src/state/folderLock.ts';
import type { LockTiming } from '../../src/state/lockTiming.ts';
import { createStateStore, parseRegistry, StateBusyError } from '../../src/state/state.ts';
import { buildTar } from '../../src/state/tar.ts';
import { volumeLockedScript } from '../../src/state/volumeBackend.ts';

// The shell installer, the volume script and the folder lock all follow the
// contract in installer/STATE.md ("The lock"). Each test has one of them hold
// the lock for longer than the dead limit and checks the others stay out.

const COMMON_SH = new URL('../../../../installer/lib/common.sh', import.meta.url).pathname;
const FAST: LockTiming = { beatSeconds: 1, deadSeconds: 3 };
const ONE_INSTANCE = { name: 'main', entries: parseRegistry('name=main\n') };
const ONE_FILE = [{ path: 'state/instances/main.conf', mode: 0o600, text: 'name=main\n' }];

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

function volumeHolder(home: string): Promise<number | null> {
  const script = volumeLockedScript({ home, command: 'sleep 7', timing: FAST });
  const child = spawn('sh', ['-c', script], { stdio: 'ignore' });
  return new Promise(resolve => {
    child.on('close', resolve);
  });
}

test('a long shell install keeps the volume script out', async () => {
  const home = await freshHome();
  const holder = shellHolder(home);
  await pause(5000);
  const script = volumeLockedScript({ home, command: 'tar -x -f -', timing: FAST });
  const result = spawnSync('sh', ['-c', script], { input: Buffer.from(buildTar(ONE_FILE)) });
  assert.equal(result.status, 3, result.stderr.toString());
  assert.equal(await holder, 0);
  await assert.rejects(access(join(home, 'state', 'lock')));
});

test('a long shell install keeps the folder writer out', async () => {
  const home = await freshHome();
  const holder = shellHolder(home);
  await pause(5000);
  const store = createStateStore(folderBackend(home, FAST));
  await assert.rejects(store.writeInstance(ONE_INSTANCE), (error: unknown) => error instanceof StateBusyError);
  assert.equal(await holder, 0);
});

test('a long volume write keeps the shell installer out', async () => {
  const home = await freshHome();
  const holder = volumeHolder(home);
  await pause(5000);
  const result = shellTries(home);
  assert.equal(result.status, 1, result.stdout.toString());
  assert.match(result.stderr.toString(), /Another install is running right now/);
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
