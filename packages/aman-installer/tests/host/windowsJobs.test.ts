import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { test } from 'node:test';

import {
  SETUP_CMD_FORWARDER,
  WindowsJobError,
  systemWindowsJobs,
  userPathHasFolder,
  windowsPaths,
} from '../../src/host/windowsJobs.ts';
import {
  RecordingProcessRunner,
  okResult,
  type ProcessBytesResult,
  type ProcessResult,
  type ProcessRunner,
} from '../../src/runner/processRunner.ts';

const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
const SELF = 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe';
const PROGRAMS_DIR = 'C:\\Users\\Friend\\AppData\\Local\\Programs\\Amanuensis';
const SHORTCUT_LISTING =
  'C:\\Users\\Friend\\Desktop\\Aman.lnk\tC:\\Users\\Friend\\AppData\\Local\\Amanuensis\\Aman-Setup.cmd\topen\n' +
  'C:\\Users\\Friend\\Desktop\\Other.lnk\tC:\\Tools\\other.exe\t\n';

// Answers the PowerShell calls from what the script asks for, so the
// recording runner can write down every command line for the golden.
class AnswerRunner implements ProcessRunner {
  private readonly userPath: string;

  constructor(userPath: string) {
    this.userPath = userPath;
  }

  run(_command: string, args: readonly string[]): Promise<ProcessResult> {
    const script = args[3] ?? '';
    if (script.includes("GetEnvironmentVariable('Path', 'User')")) {
      return Promise.resolve(okResult(this.userPath));
    }
    if (script.includes('Get-ChildItem')) {
      return Promise.resolve(okResult(SHORTCUT_LISTING));
    }
    return Promise.resolve(okResult(''));
  }

  runBytes(): Promise<ProcessBytesResult> {
    return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false });
  }
}

function jobsWith(runner: ProcessRunner, selfExePath: string = SELF) {
  return systemWindowsJobs({ runner, localAppDataDir: LOCAL_APP_DATA, selfExePath });
}

test('the golden file holds every command line the Windows jobs run', async () => {
  const recording = new RecordingProcessRunner(new AnswerRunner('C:\\Windows\\system32;C:\\Tools\r\n'));
  const jobs = jobsWith(recording);
  assert.equal(await jobs.copySelfToPrograms(), 'copied');
  assert.equal(await jobs.ensureProgramsFolderOnUserPath(), 'added');
  await jobs.listShortcuts();
  await jobs.pointShortcutAtOpen('C:\\Users\\Friend\\Desktop\\Aman.lnk');
  await jobs.ensureCheckAmanShortcut();
  await jobs.addCaCertificateToUserStore();
  await jobs.startDockerDesktop();
  await jobs.openBrowser('http://127.0.0.1:8791');
  const golden = readFileSync(new URL('../golden/windows-jobs-commands.txt', import.meta.url), 'utf8');
  assert.equal(recording.goldenText(), golden);
});

test('the Update Aman entry is made by the same shortcut owner, running aman upgrade', async () => {
  const recording = new RecordingProcessRunner(new AnswerRunner(''));
  const jobs = jobsWith(recording);
  await jobs.ensureUpdateAmanShortcut();
  assert.deepEqual(recording.lines(), [
    `powershell -NoProfile -NonInteractive -Command "$shell = New-Object -ComObject WScript.Shell; $path = Join-Path ([Environment]::GetFolderPath('Programs')) 'Update Aman.lnk'; $shortcut = $shell.CreateShortcut($path); $shortcut.TargetPath = 'C:\\Users\\Friend\\AppData\\Local\\Programs\\Amanuensis\\aman.exe'; $shortcut.Arguments = 'upgrade'; $shortcut.Save()"`,
  ]);
});

test('the shortcut listing is read into path, target and arguments', async () => {
  const jobs = jobsWith(new AnswerRunner(''));
  const shortcuts = await jobs.listShortcuts();
  assert.deepEqual(shortcuts, [
    {
      path: 'C:\\Users\\Friend\\Desktop\\Aman.lnk',
      target: 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis\\Aman-Setup.cmd',
      args: 'open',
    },
    { path: 'C:\\Users\\Friend\\Desktop\\Other.lnk', target: 'C:\\Tools\\other.exe', args: '' },
  ]);
});

test('a user PATH that already names the folder is left alone, in any case', async () => {
  const recording = new RecordingProcessRunner(
    new AnswerRunner(`C:\\Tools;c:\\users\\friend\\appdata\\local\\programs\\amanuensis\\\r\n`),
  );
  const jobs = jobsWith(recording);
  assert.equal(await jobs.ensureProgramsFolderOnUserPath(), 'present');
  // Only the read ran: no write, no broadcast.
  assert.equal(recording.lines().length, 1);
});

test('copying itself when the running file is the installed copy changes nothing', async () => {
  const recording = new RecordingProcessRunner(new AnswerRunner(''));
  const jobs = jobsWith(recording, 'c:\\users\\friend\\appdata\\local\\programs\\amanuensis\\aman.exe');
  assert.equal(await jobs.copySelfToPrograms(), 'already');
  assert.deepEqual(recording.lines(), []);
});

test('the folder test on a PATH value matches whole entries only', () => {
  assert.equal(userPathHasFolder({ pathValue: 'C:\\Tools;C:\\AmanuensisExtra', folder: PROGRAMS_DIR }), false);
  assert.equal(userPathHasFolder({ pathValue: `C:\\Tools;${PROGRAMS_DIR}`, folder: PROGRAMS_DIR }), true);
  assert.equal(userPathHasFolder({ pathValue: '', folder: PROGRAMS_DIR }), false);
});

test('the frozen Windows paths are the ones the starter named', () => {
  const paths = windowsPaths(LOCAL_APP_DATA);
  assert.equal(paths.programsExePath, 'C:\\Users\\Friend\\AppData\\Local\\Programs\\Amanuensis\\aman.exe');
  assert.equal(paths.setupCmdCopyPath, 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis\\Aman-Setup.cmd');
  assert.equal(paths.caCertPath, 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis\\ca.crt');
});

test('the forwarder golden file is the forwarder, byte for byte', () => {
  const golden = readFileSync(new URL('../golden/aman-setup-forwarder.cmd', import.meta.url), 'utf8');
  assert.equal(SETUP_CMD_FORWARDER, golden);
});

test('a forwarder write that cannot happen fails as a Windows job error', async () => {
  const jobs = systemWindowsJobs({
    runner: new AnswerRunner(''),
    // Far longer than any file name a disk allows, so the write fails.
    localAppDataDir: 'C:\\' + 'a'.repeat(300),
    selfExePath: SELF,
  });
  await assert.rejects(jobs.replaceSetupCmdCopyWithForwarder(), WindowsJobError);
});

test('a certificate write that cannot happen fails as a Windows job error', async () => {
  const jobs = systemWindowsJobs({
    runner: new AnswerRunner(''),
    // Far longer than any file name a disk allows, so the write fails.
    localAppDataDir: 'C:\\' + 'a'.repeat(300),
    selfExePath: SELF,
  });
  await assert.rejects(jobs.writeCaCertificate('certificate'), WindowsJobError);
});

test('a port a program holds is not free, and a port nobody holds is', async () => {
  const jobs = jobsWith(new AnswerRunner(''));
  const holder = createServer();
  await new Promise<void>(resolve => {
    holder.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = holder.address();
  assert.ok(typeof address === 'object' && address !== null);
  assert.equal(await jobs.portIsFree(address.port), false);
  await new Promise<void>(resolve => {
    holder.close(() => {
      resolve();
    });
  });
  assert.equal(await jobs.portIsFree(address.port), true);
});
