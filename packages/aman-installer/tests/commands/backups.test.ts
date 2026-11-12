import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBackups } from '../../src/commands/backups.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs, type FakeWindowsJobStep } from '../../src/host/fakeWindowsJobs.ts';
import { windowsPaths } from '../../src/host/windowsJobs.ts';
import {
  BACKUPS_COULD_NOT_LIST,
  BACKUPS_NOT_WINDOWS,
  NO_BACKUPS_LINE,
  backupsFolderLine,
  problemText,
} from '../../src/messages.ts';

const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
const BACKUPS_DIR = windowsPaths(LOCAL_APP_DATA).backupsDir;
const START_MENU_PROGRAMS = 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';

function jobsWith(
  options: { backups?: readonly string[]; failSteps?: ReadonlySet<FakeWindowsJobStep> } = {},
): FakeWindowsJobs {
  return new FakeWindowsJobs({
    localAppDataDir: LOCAL_APP_DATA,
    selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
    startMenuProgramsDir: START_MENU_PROGRAMS,
    ...(options.backups === undefined ? {} : { backups: options.backups }),
    ...(options.failSteps === undefined ? {} : { failSteps: options.failSteps }),
  });
}

async function run(
  jobs: FakeWindowsJobs,
  kind: 'windows' | 'darwin' = 'windows',
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runBackups({
    host: new FakeHost({ kind, memoryBytes: 8 * 1024 ** 3 }),
    jobs,
    print: line => {
      lines.push(line);
    },
  });
  return { code, lines };
}

test('the backups on this computer are listed newest first, under the folder they are in', async () => {
  const jobs = jobsWith({ backups: ['20261008T120000Z', '20261009T120000Z', '20261009T120000Z-keep'] });
  const { code, lines } = await run(jobs);
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    backupsFolderLine(BACKUPS_DIR),
    '20261009T120000Z-keep',
    '20261009T120000Z',
    '20261008T120000Z',
  ]);
  assert.deepEqual(jobs.ops, ['backupsList']);
});

test('no backups yet is a plain answer, not a problem', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run(jobs);
  assert.equal(code, 0);
  assert.deepEqual(lines, [NO_BACKUPS_LINE]);
});

test('backups refuses on a computer that is not Windows and lists nothing', async () => {
  const jobs = jobsWith({ backups: ['20261009T120000Z'] });
  const { code, lines } = await run(jobs, 'darwin');
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(BACKUPS_NOT_WINDOWS)]);
  assert.deepEqual(jobs.ops, []);
});

test('a listing that fails prints its problem', async () => {
  const jobs = jobsWith({ failSteps: new Set<FakeWindowsJobStep>(['backupsList']) });
  const { code, lines } = await run(jobs);
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(BACKUPS_COULD_NOT_LIST)]);
});
