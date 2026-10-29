import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { test } from 'node:test';

import {
  SETUP_CMD_FORWARDER,
  WindowsJobError,
  parseAclListing,
  systemWindowsJobs,
  userPathHasFolder,
  windowsPaths,
} from '../../src/host/windowsJobs.ts';
import {
  RecordingProcessRunner,
  StubProcessRunner,
  commandLine,
  okResult,
  type ProcessBytesResult,
  type ProcessResult,
  type ProcessRunner,
} from '../../src/runner/processRunner.ts';

const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
const SELF = 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe';
const PROGRAMS_DIR = 'C:\\Users\\Friend\\AppData\\Local\\Programs\\Amanuensis';
const DATA_DIR = 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis';
const SHORTCUT_LISTING =
  'C:\\Users\\Friend\\Desktop\\Aman.lnk\tC:\\Users\\Friend\\AppData\\Local\\Amanuensis\\Aman-Setup.cmd\topen\n' +
  'C:\\Users\\Friend\\Desktop\\Other.lnk\tC:\\Tools\\other.exe\t\n';
const ACL_LISTING = readFileSync(new URL('../golden/acl-listing.txt', import.meta.url), 'utf8');

// Answers the PowerShell calls from what the script asks for, and the
// account and folder access commands directly, so the recording runner
// can write down every command line for the golden.
class AnswerRunner implements ProcessRunner {
  private readonly userPath: string;
  private runOnceSet = false;

  constructor(userPath: string) {
    this.userPath = userPath;
  }

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    if (command === 'whoami') {
      return Promise.resolve(okResult('FRIEND-PC\\Friend\r\n'));
    }
    if (command === 'reg') {
      if (args[0] === 'add') {
        this.runOnceSet = true;
        return Promise.resolve(okResult(''));
      }
      if (args[0] === 'delete') {
        this.runOnceSet = false;
        return Promise.resolve(okResult(''));
      }
      if (args[0] === 'query') {
        return Promise.resolve(this.runOnceSet ? okResult('') : { exitCode: 1, stdout: '', stderr: '', started: true });
      }
    }
    if (command === 'icacls') {
      if (args.includes('/inheritance:r')) {
        return Promise.resolve(okResult('Successfully processed 1 files; Failed processing 0 files'));
      }
      return Promise.resolve(okResult(ACL_LISTING));
    }
    if (command === 'schtasks') {
      return Promise.resolve(okResult(''));
    }
    const script = args[3] ?? '';
    if (script.includes("GetEnvironmentVariable('Path', 'User')")) {
      return Promise.resolve(okResult(this.userPath));
    }
    if (script.includes('-Directory')) {
      return Promise.resolve(okResult('20261009T120000Z\r\n20261008T120000Z\r\n'));
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
  await jobs.makeFolderPrivate(DATA_DIR);
  await jobs.readFolderAcl(DATA_DIR);
  await jobs.ensureDailyBackupTask();
  assert.equal(await jobs.dailyBackupTaskPresent(), true);
  await jobs.ensureBackupsShortcut();
  assert.deepEqual(await jobs.listBackups(), ['20261009T120000Z', '20261008T120000Z']);
  await jobs.ensurePhoneShortcut();
  await jobs.openFirewallToHome([8443, 8791]);
  await jobs.closeFirewallToHome();
  assert.equal(await jobs.dockerDesktopInstallerSigner(), null);
  await jobs.ensureRunOnceResume();
  assert.equal(await jobs.runOnceResumePending(), true);
  await jobs.clearRunOnceResume();
  assert.equal(await jobs.runOnceResumePending(), false);
  await jobs.keepComputerAwake();
  const golden = readFileSync(new URL('../golden/windows-jobs-commands.txt', import.meta.url), 'utf8');
  assert.equal(recording.goldenText(), golden);
});

test('the daily backup task is absent when the query fails, and a refused make fails as a job error', async () => {
  const queryLine = commandLine('schtasks', ['/Query', '/TN', 'Amanuensis\\Daily backup']);
  const absent = new StubProcessRunner(
    new Map<string, ProcessResult>([
      [
        queryLine,
        { exitCode: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.', started: true },
      ],
    ]),
  );
  assert.equal(await jobsWith(absent).dailyBackupTaskPresent(), false);
  const createLine = commandLine('schtasks', [
    '/Create',
    '/TN',
    'Amanuensis\\Daily backup',
    '/TR',
    '"C:\\Users\\Friend\\AppData\\Local\\Programs\\Amanuensis\\aman.exe" backup',
    '/SC',
    'DAILY',
    '/ST',
    '03:30',
    '/RL',
    'LIMITED',
    '/IT',
    '/F',
  ]);
  const refused = new StubProcessRunner(
    new Map<string, ProcessResult>([
      [createLine, { exitCode: 1, stdout: '', stderr: 'ERROR: Access is denied.', started: true }],
    ]),
  );
  await assert.rejects(jobsWith(refused).ensureDailyBackupTask(), WindowsJobError);
});

test('a folder access list is read into who it names and whether they can read', async () => {
  const jobs = jobsWith(new AnswerRunner(''));
  const read = await jobs.readFolderAcl(DATA_DIR);
  assert.deepEqual(read, {
    status: 'read',
    owner: 'FRIEND-PC\\Friend',
    entries: [
      { principal: 'NT AUTHORITY\\SYSTEM', canRead: true },
      { principal: 'BUILTIN\\Administrators', canRead: true },
      { principal: 'FRIEND-PC\\Friend', canRead: true },
      { principal: 'BUILTIN\\Users', canRead: true },
      { principal: 'FRIEND-PC\\Guest', canRead: false },
      { principal: 'FRIEND-PC\\Backup', canRead: false },
      { principal: 'BUILTIN\\Users', canRead: true },
      { principal: 'BUILTIN\\Users', canRead: true },
      { principal: 'BUILTIN\\Users', canRead: true },
    ],
  });
});

test('comma-joined rights are split before they are judged for reading', () => {
  for (const rights of ['GR,GE', 'RD,REA,RA,RC', 'M,DC']) {
    assert.deepEqual(parseAclListing({ path: DATA_DIR, text: `${DATA_DIR} BUILTIN\\Users:(I)(OI)(CI)(${rights})` }), [
      { principal: 'BUILTIN\\Users', canRead: true },
    ]);
  }
});

test('a folder that is not there reads as missing, and a refused read as unreadable', async () => {
  const missing = new StubProcessRunner(
    new Map<string, ProcessResult>([
      ['whoami', okResult('FRIEND-PC\\Friend\r\n')],
      [
        commandLine('icacls', [DATA_DIR]),
        {
          exitCode: 1,
          stdout: 'Successfully processed 0 files; Failed processing 1 files',
          stderr: 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis: The system cannot find the file specified.',
          started: true,
        },
      ],
    ]),
  );
  assert.deepEqual(await jobsWith(missing).readFolderAcl(DATA_DIR), { status: 'missing' });
  const refused = new StubProcessRunner(
    new Map<string, ProcessResult>([
      ['whoami', okResult('FRIEND-PC\\Friend\r\n')],
      [
        commandLine('icacls', [DATA_DIR]),
        {
          exitCode: 1,
          stdout: 'Successfully processed 0 files; Failed processing 1 files',
          stderr: 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis: Access is denied.',
          started: true,
        },
      ],
    ]),
  );
  assert.deepEqual(await jobsWith(refused).readFolderAcl(DATA_DIR), { status: 'unreadable' });
});

test('making a folder private that refuses fails as a Windows job error', async () => {
  const refused = new StubProcessRunner(
    new Map<string, ProcessResult>([
      ['whoami', okResult('FRIEND-PC\\Friend\r\n')],
      [
        commandLine('icacls', [DATA_DIR, '/inheritance:r', '/grant:r', 'FRIEND-PC\\Friend:(OI)(CI)F']),
        { exitCode: 1, stdout: '', stderr: 'Access is denied.', started: true },
      ],
    ]),
  );
  await assert.rejects(jobsWith(refused).makeFolderPrivate(DATA_DIR), WindowsJobError);
});

// A runner that answers the elevated firewall helper and the rule
// reading from a script the test sets: the helper's exit code, and
// whether a rule is there to read.
class FirewallRunner implements ProcessRunner {
  private readonly helperExitCode: number;
  private readonly rulePresent: boolean;

  constructor(options: { helperExitCode: number; rulePresent: boolean }) {
    this.helperExitCode = options.helperExitCode;
    this.rulePresent = options.rulePresent;
  }

  run(command: string, _args: readonly string[]): Promise<ProcessResult> {
    if (command === 'netsh') {
      return Promise.resolve(
        this.rulePresent ? okResult('Rule Name: Aman\n') : { exitCode: 1, stdout: '', stderr: '', started: true },
      );
    }
    return Promise.resolve({ exitCode: this.helperExitCode, stdout: '', stderr: '', started: true });
  }

  runBytes(): Promise<ProcessBytesResult> {
    return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false });
  }
}

test('the phone entry is made by the same shortcut owner, running aman network open', async () => {
  const recording = new RecordingProcessRunner(new AnswerRunner(''));
  const jobs = jobsWith(recording);
  await jobs.ensurePhoneShortcut();
  assert.deepEqual(recording.lines(), [
    `powershell -NoProfile -NonInteractive -Command "$shell = New-Object -ComObject WScript.Shell; $path = Join-Path ([Environment]::GetFolderPath('Programs')) 'Use Aman on my phone.lnk'; $shortcut = $shell.CreateShortcut($path); $shortcut.TargetPath = 'C:\\Users\\Friend\\AppData\\Local\\Programs\\Amanuensis\\aman.exe'; $shortcut.Arguments = 'network open'; $shortcut.Save()"`,
  ]);
});

test('opening the firewall runs one elevated helper holding the delete and the add', async () => {
  const recording = new RecordingProcessRunner(new FirewallRunner({ helperExitCode: 0, rulePresent: false }));
  const jobs = jobsWith(recording);
  await jobs.openFirewallToHome([8791]);
  assert.deepEqual(recording.lines(), [
    `powershell -NoProfile -NonInteractive -Command "try { $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c netsh advfirewall firewall delete rule name=\\"Aman\\" >nul 2>&1 & netsh advfirewall firewall add rule name=\\"Aman\\" dir=in action=allow protocol=TCP localport=8791 profile=private' -Verb RunAs -Wait -PassThru -ErrorAction Stop } catch { exit 3 }; exit $p.ExitCode"`,
  ]);
});

test('a refused Windows prompt fails the firewall change', async () => {
  const jobs = jobsWith(new FirewallRunner({ helperExitCode: 3, rulePresent: false }));
  await assert.rejects(jobs.openFirewallToHome([8443, 8791]), WindowsJobError);
  await assert.rejects(jobs.closeFirewallToHome(), WindowsJobError);
});

test('a firewall helper that fails its command fails the change', async () => {
  const jobs = jobsWith(new FirewallRunner({ helperExitCode: 1, rulePresent: false }));
  await assert.rejects(jobs.openFirewallToHome([8443, 8791]), WindowsJobError);
});

test('closing the firewall with no rule there is already closed, not a failure', async () => {
  const jobs = jobsWith(new FirewallRunner({ helperExitCode: 1, rulePresent: false }));
  await jobs.closeFirewallToHome();
});

test('closing the firewall with a rule that stays on is a failure', async () => {
  const jobs = jobsWith(new FirewallRunner({ helperExitCode: 1, rulePresent: true }));
  await assert.rejects(jobs.closeFirewallToHome(), WindowsJobError);
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
  assert.equal(paths.backupsDir, 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis\\backups');
  assert.equal(paths.caCertPath, 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis\\ca.crt');
});

test('the frozen Windows paths name the Docker Desktop installer and the getting started page', () => {
  const paths = windowsPaths(LOCAL_APP_DATA);
  assert.equal(
    paths.dockerDesktopInstallerPath,
    'C:\\Users\\Friend\\AppData\\Local\\Amanuensis\\Docker Desktop Installer.exe',
  );
  assert.equal(paths.gettingStartedPath, 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis\\Getting started.html');
});

test('the signer of the saved Docker Desktop installer is read from its signature', async () => {
  const signerRunner: ProcessRunner = {
    run: (command, args) => {
      const script = args[3] ?? '';
      if (command === 'powershell' && script.includes('Get-AuthenticodeSignature')) {
        return Promise.resolve(okResult('CN=Docker Inc, O=Docker Inc, L=San Francisco, S=California, C=US\r\n'));
      }
      return Promise.resolve(okResult(''));
    },
    runBytes: () => Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false }),
  };
  const jobs = jobsWith(signerRunner);
  assert.equal(
    await jobs.dockerDesktopInstallerSigner(),
    'CN=Docker Inc, O=Docker Inc, L=San Francisco, S=California, C=US',
  );
});

test('a page write that cannot happen fails as a Windows job error', async () => {
  const jobs = systemWindowsJobs({
    runner: new AnswerRunner(''),
    // Far longer than any file name a disk allows, so the write fails.
    localAppDataDir: 'C:\\' + 'a'.repeat(300),
    selfExePath: SELF,
  });
  await assert.rejects(jobs.writeGettingStartedPage('page'), WindowsJobError);
  await assert.rejects(jobs.writeDockerDesktopInstaller(new Uint8Array([1, 2, 3])), WindowsJobError);
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
