import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runDoctorChecks, type CheckRecord, type DoctorDeps } from '../../src/doctor/doctor.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { StubProcessRunner } from '../../src/runner/processRunner.ts';
import { folderBackend } from '../../src/state/folderBackend.ts';
import { createStateStore } from '../../src/state/state.ts';

const NOW = 1791633600;
const GIB = 1024 * 1024 * 1024;

interface World {
  deps: DoctorDeps;
  stateHome: string;
}

// A world whose state record says the daily backups are on, with one
// instance. The schedule is the launchd agent file under the person's
// home, and the backups are folders in the state home, timed by their
// own folder times, as the folder store reads them.
async function makeWorld(
  options: { schedule?: boolean; backups?: readonly { name: string; daysOld: number }[] } = {},
): Promise<World> {
  const personHome = await mkdtemp(join(tmpdir(), 'aman-backup-check-'));
  const stateHome = join(personHome, '.amanuensis');
  await mkdir(join(stateHome, 'state', 'instances'), { recursive: true });
  await writeFile(join(stateHome, 'state', 'instances', 'main.conf'), 'name=main\n');
  const modePath = join(stateHome, 'state', 'backups');
  await writeFile(modePath, 'daily\n');
  // The record was written three days ago, so it is never recent:
  // whether the first backup is still to come is judged by the
  // backups themselves, not by when the choice was made.
  const modeTime = new Date((NOW - 3 * 86400) * 1000);
  await utimes(modePath, modeTime, modeTime);
  if (options.schedule === true) {
    const agentDir = join(personHome, 'Library', 'LaunchAgents');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'com.amanuensis.backup.plist'), '<plist/>\n');
  }
  for (const backup of options.backups ?? []) {
    const dir = join(stateHome, 'backups', backup.name);
    await mkdir(dir, { recursive: true });
    const when = new Date((NOW - backup.daysOld * 86400) * 1000);
    await utimes(dir, when, when);
  }
  const deps: DoctorDeps = {
    host: new FakeHost({ kind: 'linux', memoryBytes: 16 * GIB, kernelRelease: '6.8.0' }),
    runner: new StubProcessRunner(new Map()),
    store: createStateStore(folderBackend(stateHome)),
    print: () => undefined,
    now: () => NOW,
    homeDir: personHome,
    stateHome,
    osReleasePath: join(personHome, 'os-release'),
    dockerConfigDir: join(personHome, '.docker'),
    appService: 'app',
  };
  return { deps, stateHome };
}

function backupRecord(records: readonly CheckRecord[]): CheckRecord | undefined {
  return records.find(record => record.id === 'backup');
}

test('the schedule is there and the newest backup is a day old: the check passes', async () => {
  const world = await makeWorld({ schedule: true, backups: [{ name: '20261009T120000Z', daysOld: 1 }] });
  const checks = await runDoctorChecks(world.deps, { local: false });
  const record = backupRecord(checks.records);
  assert.ok(record !== undefined);
  assert.deepEqual(
    { id: record.id, state: record.state, detail: record.detail, fix: record.fix },
    { id: 'backup', state: 'ok', detail: 'Daily backups are on; the last one is 1 day old.', fix: '' },
  );
});

test('the schedule missing warns that the schedule is missing', async () => {
  const world = await makeWorld({ schedule: false, backups: [{ name: '20261009T120000Z', daysOld: 1 }] });
  const checks = await runDoctorChecks(world.deps, { local: false });
  const record = backupRecord(checks.records);
  assert.ok(record !== undefined);
  assert.deepEqual(
    { id: record.id, state: record.state, detail: record.detail, fix: record.fix },
    {
      id: 'backup',
      state: 'warn',
      detail: 'Daily backups are on, but the schedule that runs them is missing.',
      fix: 'Run aman doctor backup --fix',
    },
  );
});

test('the schedule is there but no backup has been made yet: the check warns', async () => {
  const world = await makeWorld({ schedule: true, backups: [] });
  const checks = await runDoctorChecks(world.deps, { local: false });
  const record = backupRecord(checks.records);
  assert.ok(record !== undefined);
  assert.deepEqual(
    { id: record.id, state: record.state, detail: record.detail, fix: record.fix },
    {
      id: 'backup',
      state: 'warn',
      detail: 'Daily backups are scheduled, but none has been made yet.',
      fix: 'Run aman doctor backup --fix',
    },
  );
});

test('an old newest backup is named by its place in the backups folder', async () => {
  const world = await makeWorld({ schedule: true, backups: [{ name: '20261005T120000Z', daysOld: 5 }] });
  const checks = await runDoctorChecks(world.deps, { local: false });
  const record = backupRecord(checks.records);
  assert.ok(record !== undefined);
  assert.equal(record.state, 'warn');
  assert.ok(record.detail.includes('5 days old'));
  assert.ok(record.detail.includes('~/.amanuensis/backups/20261005T120000Z'));
});
