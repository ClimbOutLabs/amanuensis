import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { folderBackend } from '../../src/state/folderBackend.ts';
import { withFolderLock } from '../../src/state/folderLock.ts';
import type { LockTiming } from '../../src/state/lockTiming.ts';
import { createStateStore, parseRegistry, StateBusyError } from '../../src/state/state.ts';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aman-state-'));
}

test('files are read and listed, and missing ones read as absent', async () => {
  const home = await tempHome();
  await mkdir(join(home, 'state', 'instances'), { recursive: true });
  await writeFile(join(home, 'state', 'instances', 'main.conf'), 'name=main\n');
  const backend = folderBackend(home);
  assert.equal(await backend.readText('state/instances/main.conf'), 'name=main\n');
  assert.equal(await backend.readText('state/instances/other.conf'), null);
  assert.deepEqual(await backend.listNames('state/instances'), ['main.conf']);
  assert.deepEqual(await backend.listNames('backups'), []);
});

test('a written file lands at mode 600 in a mode 700 folder', async () => {
  const home = await tempHome();
  const store = createStateStore(folderBackend(home));
  await store.writeInstance({ name: 'main', entries: parseRegistry('name=main\n') });
  const fileStat = await stat(join(home, 'state', 'instances', 'main.conf'));
  assert.equal(fileStat.mode & 0o777, 0o600);
  const dirStat = await stat(join(home, 'state', 'instances'));
  assert.equal(dirStat.mode & 0o777, 0o700);
  assert.equal(await readFile(join(home, 'state', 'instances', 'main.conf'), 'utf8'), 'name=main\n');
});

test('the lock is released after a write, so the next write runs', async () => {
  const home = await tempHome();
  const store = createStateStore(folderBackend(home));
  await store.writeInstance({ name: 'main', entries: parseRegistry('name=main\nhealthy=0\n') });
  assert.equal(await store.setInstanceValue({ name: 'main', key: 'healthy', value: '1' }), true);
  assert.equal(await readFile(join(home, 'state', 'instances', 'main.conf'), 'utf8'), 'name=main\nhealthy=1\n');
});

const FAST: LockTiming = { beatSeconds: 1, deadSeconds: 3 };

async function leaveLock(options: { home: string; owner: string; beatAgeSeconds: number }): Promise<string> {
  const lockDir = join(options.home, 'state', 'lock');
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner'), `${options.owner}\n`);
  await writeFile(join(lockDir, 'beat'), `${String(Math.floor(Date.now() / 1000) - options.beatAgeSeconds)}\n`);
  return lockDir;
}

const ONE_INSTANCE = { name: 'main', entries: parseRegistry('name=main\n') };

test('a lock with a fresh beat refuses the write, whatever process it names', async () => {
  const home = await tempHome();
  const lockDir = await leaveLock({ home, owner: 'other-run', beatAgeSeconds: 0 });
  await writeFile(join(lockDir, 'pid'), '999999999\n');
  const store = createStateStore(folderBackend(home));
  await assert.rejects(store.writeInstance(ONE_INSTANCE), (error: unknown) => error instanceof StateBusyError);
  assert.equal((await readFile(join(lockDir, 'owner'), 'utf8')).trim(), 'other-run');
});

test('a lock whose beat stopped is taken over, even when its pid names a live process', async () => {
  const home = await tempHome();
  const lockDir = await leaveLock({ home, owner: 'other-run', beatAgeSeconds: 3600 });
  await writeFile(join(lockDir, 'pid'), `${String(process.pid)}\n`);
  const store = createStateStore(folderBackend(home));
  assert.equal(await store.writeInstance(ONE_INSTANCE), true);
  await assert.rejects(access(lockDir));
});

test('a run longer than the dead limit keeps its lock by beating', async () => {
  const home = await tempHome();
  const lockDir = join(home, 'state', 'lock');
  let sawLiveAfterLimit = false;
  await withFolderLock({
    home,
    timing: FAST,
    run: async () => {
      await new Promise(resolve => setTimeout(resolve, 4500));
      const second = createStateStore(folderBackend(home, FAST));
      await assert.rejects(second.writeInstance(ONE_INSTANCE), (error: unknown) => error instanceof StateBusyError);
      sawLiveAfterLimit = true;
    },
  });
  assert.equal(sawLiveAfterLimit, true);
  await assert.rejects(access(lockDir));
});

test('a holder whose lock was taken over leaves the new holder lock in place', async () => {
  const home = await tempHome();
  const lockDir = join(home, 'state', 'lock');
  await withFolderLock({
    home,
    timing: FAST,
    run: async () => {
      await rm(lockDir, { recursive: true });
      await leaveLock({ home, owner: 'new-run', beatAgeSeconds: 0 });
    },
  });
  assert.equal((await readFile(join(lockDir, 'owner'), 'utf8')).trim(), 'new-run');
});

test('when several runs find a lock whose beat stopped together, never two hold it at once', async () => {
  const home = await tempHome();
  await leaveLock({ home, owner: 'other-run', beatAgeSeconds: 3600 });
  let holding = 0;
  let mostAtOnce = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      withFolderLock({
        home,
        timing: FAST,
        run: async () => {
          holding += 1;
          mostAtOnce = Math.max(mostAtOnce, holding);
          await new Promise(resolve => setTimeout(resolve, 300));
          holding -= 1;
        },
      }),
    ),
  );
  assert.equal(mostAtOnce, 1);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.ok(result.reason instanceof StateBusyError, String(result.reason));
    }
  }
});
