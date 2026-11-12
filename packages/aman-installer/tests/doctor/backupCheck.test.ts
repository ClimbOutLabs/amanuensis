import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runDoctorChecks, type CheckRecord, type DoctorDeps } from '../../src/doctor/doctor.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs } from '../../src/host/fakeWindowsJobs.ts';
import { windowsPaths } from '../../src/host/windowsJobs.ts';
import { StubProcessRunner } from '../../src/runner/processRunner.ts';
import { folderBackend } from '../../src/state/folderBackend.ts';
import { createStateStore } from '../../src/state/state.ts';

const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
const BACKUPS_DIR = windowsPaths(LOCAL_APP_DATA).backupsDir;
const START_MENU_PROGRAMS = 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';
const NOW = 1791633600;
const GIB = 1024 * 1024 * 1024;

interface World {
  deps: DoctorDeps;
  jobs: FakeWindowsJobs;
}

// A Windows world whose state record says the daily backups are on,
// with one instance. The store's own backups folder is empty on
// purpose: on Windows the backups land in the folder on the PC, so
// every age the check reports must come from the jobs' listing.
async function makeWorld(
  options: { backupTask?: boolean; backups?: readonly string[]; withJobs?: boolean } = {},
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
  const jobs = new FakeWindowsJobs({
    localAppDataDir: LOCAL_APP_DATA,
    selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
    startMenuProgramsDir: START_MENU_PROGRAMS,
    ...(options.backupTask === undefined ? {} : { backupTask: options.backupTask }),
    ...(options.backups === undefined ? {} : { backups: options.backups }),
  });
  const deps: DoctorDeps = {
    host: new FakeHost({ kind: 'windows', memoryBytes: 16 * GIB, kernelRelease: '10.0.26100' }),
    runner: new StubProcessRunner(new Map()),
    store: createStateStore(folderBackend(stateHome)),
    print: () => undefined,
    now: () => NOW,
    homeDir: personHome,
    stateHome: null,
    osReleasePath: join(personHome, 'os-release'),
    dockerConfigDir: join(personHome, '.docker'),
    appService: 'app',
    ...(options.withJobs === false ? {} : { windowsJobs: jobs }),
  };
  return { deps, jobs };
}

function backupRecord(records: readonly CheckRecord[]): CheckRecord | undefined {
  return records.find(record => record.id === 'backup');
}

test('the task is there and the newest backup on the disk is a day old: the check passes', async () => {
  const world = await makeWorld({ backupTask: true, backups: ['20261009T120000Z'] });
  const checks = await runDoctorChecks(world.deps, { local: false });
  const record = backupRecord(checks.records);
  assert.ok(record !== undefined);
  assert.deepEqual(
    { id: record.id, state: record.state, detail: record.detail, fix: record.fix },
    { id: 'backup', state: 'ok', detail: 'Daily backups are on; the last one is 1 day old.', fix: '' },
  );
  assert.ok(world.jobs.ops.includes('taskQuery'));
  assert.ok(world.jobs.ops.includes('backupsList'));
});

test('the task missing warns that the schedule is missing', async () => {
  const world = await makeWorld({ backupTask: false, backups: ['20261009T120000Z'] });
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

test('the task is there but no backup has been made yet: the check warns', async () => {
  const world = await makeWorld({ backupTask: true, backups: [] });
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

test('an old newest backup is named by its place on the Windows disk', async () => {
  const world = await makeWorld({ backupTask: true, backups: ['20261005T120000Z'] });
  const checks = await runDoctorChecks(world.deps, { local: false });
  const record = backupRecord(checks.records);
  assert.ok(record !== undefined);
  assert.deepEqual(
    { id: record.id, state: record.state, detail: record.detail, fix: record.fix },
    {
      id: 'backup',
      state: 'warn',
      detail: `Daily backups are scheduled, but the last one is 5 days old. The newest backup is in ${BACKUPS_DIR}\\20261005T120000Z.`,
      fix: 'Run aman doctor backup --fix',
    },
  );
});

test('without the Windows jobs the check falls back to the schedules it always probed', async () => {
  const world = await makeWorld({ backupTask: true, backups: ['20261009T120000Z'], withJobs: false });
  const checks = await runDoctorChecks(world.deps, { local: false });
  const record = backupRecord(checks.records);
  assert.ok(record !== undefined);
  // No task is asked about, and the store holds no backups, so the
  // schedule reads as missing, exactly as before the task existed.
  assert.equal(record.state, 'warn');
  assert.equal(record.detail, 'Daily backups are on, but the schedule that runs them is missing.');
  assert.deepEqual(world.jobs.ops, []);
});
