import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runDoctor, runDoctorChecks, type CheckRecord, type DoctorDeps } from '../../src/doctor/doctor.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs, type FakeWindowsJobStep } from '../../src/host/fakeWindowsJobs.ts';
import type { SystemKind } from '../../src/host/host.ts';
import { systemWindowsJobs, windowsPaths, type AclRead } from '../../src/host/windowsJobs.ts';
import {
  FILES_COULD_NOT_CHECK,
  FILES_COULD_NOT_FIX,
  FILES_MADE_PRIVATE_LINE,
  FILES_NOT_PRIVATE,
  FILES_PRIVATE_LINE,
} from '../../src/messages.ts';
import { StubProcessRunner, commandLine, okResult, type ProcessResult } from '../../src/runner/processRunner.ts';
import { folderBackend } from '../../src/state/folderBackend.ts';
import { createStateStore } from '../../src/state/state.ts';

const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
const DATA_DIR = windowsPaths(LOCAL_APP_DATA).dataDir;
const OWNER = 'FRIEND-PC\\Friend';
const GIB = 1024 * 1024 * 1024;

const PRIVATE_READ: AclRead = {
  status: 'read',
  owner: OWNER,
  entries: [{ principal: OWNER, canRead: true }],
};

// The list a folder made the usual Windows way starts with: the system
// and the administrators can read it too, so the check fails.
const OPEN_READ: AclRead = {
  status: 'read',
  owner: OWNER,
  entries: [
    { principal: 'NT AUTHORITY\\SYSTEM', canRead: true },
    { principal: 'BUILTIN\\Administrators', canRead: true },
    { principal: OWNER, canRead: true },
  ],
};

interface World {
  deps: DoctorDeps;
  jobs: FakeWindowsJobs;
  printed: string[];
}

// A Windows world whose other checks have nothing to say: Docker does
// not answer, so most of them skip, and the tests read the files record
// on its own.
async function makeWorld(
  options: {
    kind?: SystemKind;
    acls?: ReadonlyMap<string, AclRead>;
    failSteps?: ReadonlySet<FakeWindowsJobStep>;
  } = {},
): Promise<World> {
  const personHome = await mkdtemp(join(tmpdir(), 'aman-files-person-'));
  const jobs = new FakeWindowsJobs({
    localAppDataDir: LOCAL_APP_DATA,
    selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
    startMenuProgramsDir: 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    aclOwner: OWNER,
    ...(options.acls === undefined ? {} : { acls: options.acls }),
    ...(options.failSteps === undefined ? {} : { failSteps: options.failSteps }),
  });
  const printed: string[] = [];
  const deps: DoctorDeps = {
    host: new FakeHost({ kind: options.kind ?? 'windows', memoryBytes: 16 * GIB, kernelRelease: '10.0.26100' }),
    runner: new StubProcessRunner(new Map()),
    store: createStateStore(folderBackend(join(personHome, '.amanuensis'))),
    print: (line: string) => {
      printed.push(line);
    },
    now: () => 1791633600,
    homeDir: personHome,
    stateHome: null,
    osReleasePath: join(personHome, 'os-release'),
    dockerConfigDir: join(personHome, '.docker'),
    appService: 'app',
    windowsJobs: jobs,
  };
  return { deps, jobs, printed };
}

function filesRecord(records: readonly CheckRecord[]): CheckRecord | undefined {
  return records.find(record => record.id === 'files');
}

function aclOps(jobs: FakeWindowsJobs): string[] {
  return jobs.ops.filter(op => op.startsWith('acl'));
}

test('a folder only the person can read passes the files check', async () => {
  const world = await makeWorld({ acls: new Map([[DATA_DIR, PRIVATE_READ]]) });
  const checks = await runDoctorChecks(world.deps, { local: false, files: true });
  const record = filesRecord(checks.records);
  assert.ok(record !== undefined);
  assert.equal(record.state, 'ok');
  assert.equal(record.detail, FILES_PRIVATE_LINE);
  assert.equal(record.fix, '');
  assert.deepEqual(aclOps(world.jobs), ['aclRead']);
});

test('a folder other accounts can read fails, with the fix the check promises', async () => {
  const world = await makeWorld({ acls: new Map([[DATA_DIR, OPEN_READ]]) });
  const checks = await runDoctorChecks(world.deps, { local: false, files: true });
  const record = filesRecord(checks.records);
  assert.ok(record !== undefined);
  assert.equal(record.state, 'fail');
  assert.equal(record.detail, FILES_NOT_PRIVATE.happened);
  assert.equal(record.fix, FILES_NOT_PRIVATE.fix);
  // Without Fix asked for, nothing is changed.
  assert.deepEqual(aclOps(world.jobs), ['aclRead']);
});

test('a folder whose listing joins read rights with commas is judged open', async () => {
  const world = await makeWorld();
  const runner = new StubProcessRunner(
    new Map<string, ProcessResult>([
      ['whoami', okResult(`${OWNER}\r\n`)],
      [commandLine('icacls', [DATA_DIR]), okResult(`${DATA_DIR} BUILTIN\\Users:(I)(OI)(CI)(RD,REA,RA,RC)\r\n`)],
    ]),
  );
  world.deps.windowsJobs = systemWindowsJobs({
    runner,
    localAppDataDir: LOCAL_APP_DATA,
    selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
  });
  const checks = await runDoctorChecks(world.deps, { local: false, files: true });
  const record = filesRecord(checks.records);
  assert.ok(record !== undefined);
  assert.equal(record.state, 'fail');
  assert.equal(record.detail, FILES_NOT_PRIVATE.happened);
  assert.equal(record.fix, FILES_NOT_PRIVATE.fix);
});

test('with Fix, the folder is made private and read back before the check passes', async () => {
  const world = await makeWorld({ acls: new Map([[DATA_DIR, OPEN_READ]]) });
  const checks = await runDoctorChecks(world.deps, { local: false, files: true, fix: true });
  const record = filesRecord(checks.records);
  assert.ok(record !== undefined);
  assert.equal(record.state, 'ok');
  assert.equal(record.detail, FILES_MADE_PRIVATE_LINE);
  assert.deepEqual(aclOps(world.jobs), ['aclRead', 'aclPrivate', 'aclRead']);
});

test('with Fix, a folder that cannot be made private still fails', async () => {
  const world = await makeWorld({
    acls: new Map([[DATA_DIR, OPEN_READ]]),
    failSteps: new Set<FakeWindowsJobStep>(['aclPrivate']),
  });
  const checks = await runDoctorChecks(world.deps, { local: false, files: true, fix: true });
  const record = filesRecord(checks.records);
  assert.ok(record !== undefined);
  assert.equal(record.state, 'fail');
  assert.equal(record.detail, FILES_COULD_NOT_FIX.happened);
  assert.equal(record.fix, FILES_COULD_NOT_FIX.fix);
});

test('a folder whose list cannot be read fails as a check that could not be made', async () => {
  const world = await makeWorld({ acls: new Map<string, AclRead>([[DATA_DIR, { status: 'unreadable' }]]) });
  const checks = await runDoctorChecks(world.deps, { local: false, files: true });
  const record = filesRecord(checks.records);
  assert.ok(record !== undefined);
  assert.equal(record.state, 'fail');
  assert.equal(record.detail, FILES_COULD_NOT_CHECK.happened);
  assert.equal(record.fix, FILES_COULD_NOT_CHECK.fix);
});

test('before anything is on the Windows disk, the check records nothing', async () => {
  const world = await makeWorld();
  const checks = await runDoctorChecks(world.deps, { local: false, files: true });
  assert.equal(filesRecord(checks.records), undefined);
  assert.deepEqual(aclOps(world.jobs), ['aclRead']);
});

test('the check is not one of the records the upgrade gate judges', async () => {
  const world = await makeWorld({ acls: new Map([[DATA_DIR, OPEN_READ]]) });
  const checks = await runDoctorChecks(world.deps, { local: true });
  assert.equal(filesRecord(checks.records), undefined);
  assert.deepEqual(aclOps(world.jobs), []);
});

test('on any other system the check records nothing', async () => {
  const world = await makeWorld({ kind: 'linux', acls: new Map([[DATA_DIR, OPEN_READ]]) });
  const checks = await runDoctorChecks(world.deps, { local: false, files: true });
  assert.equal(filesRecord(checks.records), undefined);
  assert.deepEqual(aclOps(world.jobs), []);
});

interface JsonRecord {
  id: string;
  state: string;
  detail: string;
  fix: string;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'state' in value &&
    typeof value.state === 'string' &&
    'detail' in value &&
    typeof value.detail === 'string' &&
    'fix' in value &&
    typeof value.fix === 'string'
  );
}

test('the doctor a person runs reports the fixed folder in its document', async () => {
  const world = await makeWorld({ acls: new Map([[DATA_DIR, OPEN_READ]]) });
  await runDoctor(world.deps, { json: true, fix: true });
  assert.equal(world.printed.length, 1);
  const doc: unknown = JSON.parse(world.printed[0] ?? '');
  if (typeof doc !== 'object' || doc === null || !('machine' in doc)) {
    throw new Error('the doctor document has no machine checks');
  }
  const machine: unknown = doc.machine;
  assert.ok(Array.isArray(machine));
  const record = machine.filter(isJsonRecord).find(entry => entry.id === 'files');
  assert.ok(record !== undefined);
  assert.equal(record.state, 'ok');
  assert.equal(record.detail, FILES_MADE_PRIVATE_LINE);
});
