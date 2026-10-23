import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { folderBackend } from '../../src/state/folderBackend.ts';
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

test('a lock held by a live process refuses the write', async () => {
  const home = await tempHome();
  const lockDir = join(home, 'state', 'lock');
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'pid'), `${String(process.pid)}\n`);
  const store = createStateStore(folderBackend(home));
  await assert.rejects(
    store.writeInstance({ name: 'main', entries: parseRegistry('name=main\n') }),
    (error: unknown) => error instanceof StateBusyError,
  );
});

test('a lock left by a dead process is taken over', async () => {
  const home = await tempHome();
  const lockDir = join(home, 'state', 'lock');
  await mkdir(lockDir, { recursive: true });
  // A pid far above any real one cannot be alive.
  await writeFile(join(lockDir, 'pid'), '999999999\n');
  const store = createStateStore(folderBackend(home));
  assert.equal(await store.writeInstance({ name: 'main', entries: parseRegistry('name=main\n') }), true);
});
