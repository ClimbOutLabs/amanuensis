import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { win32 } from 'node:path';

import type { ProcessRunner } from '../runner/processRunner.ts';

// The Windows names the starter froze (the starter spec, plan section 7):
// the folder %LOCALAPPDATA%\Amanuensis holds the starter's copy of
// Aman-Setup.cmd, and the aman command lives in
// %LOCALAPPDATA%\Programs\Amanuensis\aman.exe.
export const WINDOWS_FOLDER_NAME = 'Amanuensis';
export const PROGRAMS_PARENT_NAME = 'Programs';
export const EXE_FILE_NAME = 'aman.exe';
export const SETUP_CMD_FILE_NAME = 'Aman-Setup.cmd';
// The name the authority's certificate is downloaded under on the trust
// page, and the name it is kept under in the Amanuensis folder here.
export const CA_CERT_FILE_NAME = 'ca.crt';
// The Start menu entry the plan names, running aman doctor.
export const CHECK_AMAN_SHORTCUT_NAME = 'Check Aman';
// The Start menu entry the upgrade keeps, running aman upgrade.
export const UPDATE_AMAN_SHORTCUT_NAME = 'Update Aman';
// The Start menu entry that opens the folder the backups land in.
export const BACKUPS_SHORTCUT_NAME = 'Backups';
// The folder inside the Amanuensis folder where the backups land on
// the Windows disk, named as the shell names its backups folder.
export const BACKUPS_FOLDER_NAME = 'backups';
// The Task Scheduler task that makes the daily backup, in the folder
// the plan froze, at the shell schedule's hour (schedule.sh).
export const BACKUP_TASK_NAME = 'Amanuensis\\Daily backup';
export const BACKUP_TASK_TIME = '03:30';
// The Start menu entry that shows the phone address and scan code
// again, running aman network open.
export const PHONE_SHORTCUT_NAME = 'Use Aman on my phone';
// The one inbound firewall rule that lets devices on the private
// networks reach Aman: one name, so it can be found, changed and
// (on uninstall) removed.
export const FIREWALL_RULE_NAME = 'Aman';
// Docker Desktop's own install place, the file the starter starts.
export const DOCKER_DESKTOP_EXE = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';

// What replaces the starter's copy of Aman-Setup.cmd: three lines that
// hand every argument to the aman command, so a shortcut or a habit that
// still points at the file keeps working.
export const SETUP_CMD_FORWARDER = [
  '@echo off',
  '"%LOCALAPPDATA%\\Programs\\Amanuensis\\aman.exe" %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');

export interface WindowsPaths {
  programsDir: string;
  programsExePath: string;
  dataDir: string;
  setupCmdCopyPath: string;
  backupsDir: string;
  caCertPath: string;
}

export function windowsPaths(localAppDataDir: string): WindowsPaths {
  const programsDir = win32.join(localAppDataDir, PROGRAMS_PARENT_NAME, WINDOWS_FOLDER_NAME);
  const dataDir = win32.join(localAppDataDir, WINDOWS_FOLDER_NAME);
  return {
    programsDir,
    programsExePath: win32.join(programsDir, EXE_FILE_NAME),
    dataDir,
    setupCmdCopyPath: win32.join(dataDir, SETUP_CMD_FILE_NAME),
    backupsDir: win32.join(dataDir, BACKUPS_FOLDER_NAME),
    caCertPath: win32.join(dataDir, CA_CERT_FILE_NAME),
  };
}

export interface ShortcutFacts {
  path: string;
  target: string;
  args: string;
}

// One line of a folder's access list, read back as facts: who the line
// names, and whether it lets them read what is in the folder.
export interface AclEntry {
  principal: string;
  canRead: boolean;
}

// What reading a folder's access list found: the entries and the
// person's own account name as the list prints it, or why there is no
// answer. A folder that is not there is its own answer, because a check
// before anything is installed has nothing to judge.
export type AclRead =
  { status: 'read'; owner: string; entries: readonly AclEntry[] } | { status: 'missing' } | { status: 'unreadable' };

export class WindowsJobError extends Error {}

// The rights words that let a principal read what is in a folder: full
// control, modify and read-and-run all include reading, and so do the
// plain read, the generic read and generic all rights, and the read
// parts of a detailed list (data, attributes, extended attributes and
// permissions).
const ACL_READ_TOKENS: ReadonlySet<string> = new Set(['F', 'M', 'RX', 'R', 'GR', 'GA', 'RD', 'RA', 'REA', 'RC']);

// The lines icacls prints for a folder, read into entries. The first
// line starts with the folder itself, the rest are indented under it,
// and the summary lines below the entries are not entries. A deny line
// grants nothing, whatever else it says.
export function parseAclListing(options: { path: string; text: string }): AclEntry[] {
  const entries: AclEntry[] = [];
  for (const rawLine of options.text.split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    if (line.startsWith(options.path)) {
      line = line.slice(options.path.length);
    }
    line = line.trim();
    const colon = line.lastIndexOf(':(');
    if (colon <= 0) {
      continue;
    }
    const principal = line.slice(0, colon).trim();
    if (principal === '') {
      continue;
    }
    const groups: string[] = [];
    for (const match of line.slice(colon + 1).matchAll(/\(([^)]*)\)/g)) {
      groups.push(match[1] ?? '');
    }
    const canRead =
      !groups.includes('DENY') && groups.some(group => group.split(',').some(part => ACL_READ_TOKENS.has(part.trim())));
    entries.push({ principal, canRead });
  }
  return entries;
}

// True when the user PATH value already names the folder, in any letter
// case, with or without a trailing backslash.
export function userPathHasFolder(options: { pathValue: string; folder: string }): boolean {
  const wanted = options.folder.replace(/\\+$/, '').toLowerCase();
  return options.pathValue
    .split(';')
    .map(entry => entry.trim().replace(/\\+$/, '').toLowerCase())
    .some(entry => entry === wanted);
}

// The host jobs only a Windows PC has: putting the aman command in place,
// the shortcuts, starting Docker Desktop and opening the browser. Each
// one runs through the process runner (or, for the forwarder file, a
// plain write), so a test can record or answer every step.
export interface WindowsJobs {
  readonly programsExePath: string;
  readonly setupCmdCopyPath: string;
  // The folder under the per-user application data folder where Aman
  // keeps its own files on this PC: the Aman-Setup copy lives there.
  readonly dataDir: string;
  // The folder inside it where the backups land on this PC.
  readonly backupsDir: string;
  // Copies the running executable into the Programs folder. 'already'
  // when the running executable is the copy there (adopt run twice).
  copySelfToPrograms: () => Promise<'copied' | 'already'>;
  // Adds the Programs folder to the user PATH and broadcasts the change
  // so new terminal windows see it. 'present' when it was already there.
  ensureProgramsFolderOnUserPath: () => Promise<'added' | 'present'>;
  // Every shortcut on the desktop and in the Start menu, with the file
  // it points at and the arguments it passes.
  listShortcuts: () => Promise<readonly ShortcutFacts[]>;
  // Points one shortcut at the aman command, opening Aman.
  pointShortcutAtOpen: (shortcutPath: string) => Promise<void>;
  // Makes the "Check Aman" Start menu entry, or points the existing one
  // at the aman command, running aman doctor.
  ensureCheckAmanShortcut: () => Promise<void>;
  // Makes the "Update Aman" Start menu entry, or points the existing
  // one at the aman command, running aman upgrade.
  ensureUpdateAmanShortcut: () => Promise<void>;
  // Makes the "Backups" Start menu entry, or points the existing one
  // at the folder the backups land in, so choosing it opens that folder.
  ensureBackupsShortcut: () => Promise<void>;
  // Makes the daily backup task, or remakes it in the same shape:
  // every day at 03:30, running aman backup as the person, only while
  // they are signed in, with no password stored.
  ensureDailyBackupTask: () => Promise<void>;
  // True when the daily backup task is there.
  dailyBackupTaskPresent: () => Promise<boolean>;
  // The names in the backups folder, as they stand. A folder that is
  // not there yet lists as empty.
  listBackups: () => Promise<readonly string[]>;
  // Makes the "Use Aman on my phone" Start menu entry, or points the
  // existing one at the aman command, running aman network open.
  ensurePhoneShortcut: () => Promise<void>;
  // Lets devices on the private networks reach Aman: one inbound
  // firewall rule for the given ports, the Private profile only, made
  // by one short elevated helper process (one Windows prompt). A rule
  // already there under the same name is replaced.
  openFirewallToHome: (ports: readonly number[]) => Promise<void>;
  // Turns that rule off, so devices on the network can no longer reach
  // Aman. The rule itself is removed only on uninstall. A rule that is
  // not there at all is already closed, and is not a failure.
  closeFirewallToHome: () => Promise<void>;
  // Replaces the starter's copy of Aman-Setup.cmd with the forwarder.
  replaceSetupCmdCopyWithForwarder: () => Promise<void>;
  // Writes the local authority's certificate, public part only, into
  // the Amanuensis folder, the file the trust step below names.
  writeCaCertificate: (certText: string) => Promise<void>;
  // Adds that certificate to the person's own Root store: Windows asks
  // once with a Yes/No dialog, and no administrator rights are needed.
  addCaCertificateToUserStore: () => Promise<void>;
  startDockerDesktop: () => Promise<void>;
  openBrowser: (url: string) => Promise<void>;
  // Makes a folder private to the person: inherited access is removed
  // and only their own account keeps full control, which the folders
  // and files later made inside it inherit.
  makeFolderPrivate: (path: string) => Promise<void>;
  // Reads a folder's access list back, for the doctor to judge.
  readFolderAcl: (path: string) => Promise<AclRead>;
  // True when the port can be bound on loopback and on any-address: the
  // bind is the real test, as the shell's port check does it.
  portIsFree: (port: number) => Promise<boolean>;
}

// A PowerShell string literal: single-quoted, with its quotes doubled.
function psQuote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function bindWorks(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

// The shipped jobs: one-line PowerShell calls through the runner (the
// plan's shape for shortcut work), the forwarder as a file write, and
// port binds through Node's net.
export function systemWindowsJobs(options: {
  runner: ProcessRunner;
  localAppDataDir: string;
  selfExePath: string;
}): WindowsJobs {
  const { runner } = options;
  const paths = windowsPaths(options.localAppDataDir);

  const runPowerShell = async (script: string): Promise<string> => {
    const result = await runner.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (!result.started || result.exitCode !== 0) {
      throw new WindowsJobError(`a Windows step did not run: ${script}`);
    }
    return result.stdout;
  };

  // The person's own account name, the way the access list prints it,
  // asked for once: the folder access jobs need it to grant access and
  // to say whose access is expected.
  let userName: Promise<string> | null = null;
  const currentUserName = (): Promise<string> => {
    userName ??= (async () => {
      const result = await runner.run('whoami', []);
      const name = result.stdout.trim();
      if (!result.started || result.exitCode !== 0 || name === '') {
        throw new WindowsJobError("this computer's account name could not be read");
      }
      return name;
    })();
    return userName;
  };

  // Changing the firewall needs the person's one Yes to the Windows
  // prompt, so the netsh command runs in a short elevated helper
  // process and this side only reads how it ended: 3 is the helper
  // never starting (the prompt was refused), anything else is the
  // netsh command's own exit code, handed back for the caller to judge.
  const runElevatedNetsh = async (argumentList: string): Promise<number> => {
    const script =
      `try { $p = Start-Process -FilePath 'cmd.exe' -ArgumentList ${psQuote(argumentList)} ` +
      `-Verb RunAs -Wait -PassThru -ErrorAction Stop } catch { exit 3 }; exit $p.ExitCode`;
    const result = await runner.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (!result.started) {
      throw new WindowsJobError('the Windows step to change the firewall rule did not run');
    }
    if (result.exitCode === 3) {
      throw new WindowsJobError('the Windows prompt for the firewall change was refused');
    }
    return result.exitCode;
  };

  return {
    programsExePath: paths.programsExePath,
    setupCmdCopyPath: paths.setupCmdCopyPath,
    dataDir: paths.dataDir,
    backupsDir: paths.backupsDir,

    async copySelfToPrograms() {
      if (options.selfExePath.toLowerCase() === paths.programsExePath.toLowerCase()) {
        return 'already';
      }
      await runPowerShell(
        `New-Item -ItemType Directory -Force -Path ${psQuote(paths.programsDir)} | Out-Null; ` +
          `Copy-Item -LiteralPath ${psQuote(options.selfExePath)} -Destination ${psQuote(paths.programsExePath)} -Force`,
      );
      return 'copied';
    },

    async ensureProgramsFolderOnUserPath() {
      const current = (await runPowerShell("[Environment]::GetEnvironmentVariable('Path', 'User')")).replace(
        /\r?\n$/,
        '',
      );
      if (userPathHasFolder({ pathValue: current, folder: paths.programsDir })) {
        return 'present';
      }
      const next = current.trim() === '' ? paths.programsDir : `${current.replace(/;+$/, '')};${paths.programsDir}`;
      await runPowerShell(`[Environment]::SetEnvironmentVariable('Path', ${psQuote(next)}, 'User')`);
      // The broadcast that tells running programs the environment
      // changed, so new terminal windows pick the folder up.
      await runPowerShell(
        `Add-Type -Name 'AmanNative' -Namespace 'Aman' -MemberDefinition ` +
          `'[DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)] public static extern IntPtr ` +
          `SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, ` +
          `out UIntPtr lpdwResult);'; $result = [UIntPtr]::Zero; ` +
          `[void][Aman.AmanNative]::SendMessageTimeout([IntPtr]::new(0xFFFF), 0x1A, [UIntPtr]::Zero, ` +
          `'Environment', 2, 5000, [ref]$result)`,
      );
      return 'added';
    },

    async listShortcuts() {
      const stdout = await runPowerShell(
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ` +
          `$shell = New-Object -ComObject WScript.Shell; ` +
          `$folders = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')); ` +
          `foreach ($folder in $folders) { ` +
          `Get-ChildItem -Path $folder -Filter '*.lnk' -Recurse -File | ForEach-Object { ` +
          `$shortcut = $shell.CreateShortcut($_.FullName); ` +
          `Write-Output ($_.FullName + "\`t" + $shortcut.TargetPath + "\`t" + $shortcut.Arguments) } }`,
      );
      const facts: ShortcutFacts[] = [];
      for (const line of stdout.split('\n')) {
        const parts = line.replace(/\r$/, '').split('\t');
        const path = parts[0];
        if (path === undefined || path === '') {
          continue;
        }
        facts.push({ path, target: parts[1] ?? '', args: parts.slice(2).join('\t') });
      }
      return facts;
    },

    async pointShortcutAtOpen(shortcutPath: string) {
      await runPowerShell(
        `$shell = New-Object -ComObject WScript.Shell; ` +
          `$shortcut = $shell.CreateShortcut(${psQuote(shortcutPath)}); ` +
          `$shortcut.TargetPath = ${psQuote(paths.programsExePath)}; ` +
          `$shortcut.Arguments = 'open'; $shortcut.Save()`,
      );
    },

    async ensureCheckAmanShortcut() {
      await runPowerShell(
        `$shell = New-Object -ComObject WScript.Shell; ` +
          `$path = Join-Path ([Environment]::GetFolderPath('Programs')) ${psQuote(`${CHECK_AMAN_SHORTCUT_NAME}.lnk`)}; ` +
          `$shortcut = $shell.CreateShortcut($path); ` +
          `$shortcut.TargetPath = ${psQuote(paths.programsExePath)}; ` +
          `$shortcut.Arguments = 'doctor'; $shortcut.Save()`,
      );
    },

    async ensureUpdateAmanShortcut() {
      await runPowerShell(
        `$shell = New-Object -ComObject WScript.Shell; ` +
          `$path = Join-Path ([Environment]::GetFolderPath('Programs')) ${psQuote(`${UPDATE_AMAN_SHORTCUT_NAME}.lnk`)}; ` +
          `$shortcut = $shell.CreateShortcut($path); ` +
          `$shortcut.TargetPath = ${psQuote(paths.programsExePath)}; ` +
          `$shortcut.Arguments = 'upgrade'; $shortcut.Save()`,
      );
    },

    async ensureBackupsShortcut() {
      await runPowerShell(
        `$shell = New-Object -ComObject WScript.Shell; ` +
          `$path = Join-Path ([Environment]::GetFolderPath('Programs')) ${psQuote(`${BACKUPS_SHORTCUT_NAME}.lnk`)}; ` +
          `$shortcut = $shell.CreateShortcut($path); ` +
          `$shortcut.TargetPath = ${psQuote(paths.backupsDir)}; $shortcut.Save()`,
      );
    },

    async ensureDailyBackupTask() {
      // /F remakes a task that is already there, so making it again
      // leaves the same task, as the other ensure steps leave the same
      // entry. No user or password is named: the task runs as the
      // person, and /IT runs it only while they are signed in.
      const result = await runner.run('schtasks', [
        '/Create',
        '/TN',
        BACKUP_TASK_NAME,
        '/TR',
        `"${paths.programsExePath}" backup`,
        '/SC',
        'DAILY',
        '/ST',
        BACKUP_TASK_TIME,
        '/RL',
        'LIMITED',
        '/IT',
        '/F',
      ]);
      if (!result.started || result.exitCode !== 0) {
        throw new WindowsJobError('the daily backup task could not be made');
      }
    },

    async dailyBackupTaskPresent() {
      const result = await runner.run('schtasks', ['/Query', '/TN', BACKUP_TASK_NAME]);
      return result.started && result.exitCode === 0;
    },

    async listBackups() {
      const stdout = await runPowerShell(
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ` +
          `if (Test-Path -LiteralPath ${psQuote(paths.backupsDir)}) { ` +
          `Get-ChildItem -LiteralPath ${psQuote(paths.backupsDir)} -Directory | ForEach-Object { $_.Name } }`,
      );
      return stdout
        .split('\n')
        .map(line => line.replace(/\r$/, '').trim())
        .filter(line => line !== '');
    },

    async ensurePhoneShortcut() {
      await runPowerShell(
        `$shell = New-Object -ComObject WScript.Shell; ` +
          `$path = Join-Path ([Environment]::GetFolderPath('Programs')) ${psQuote(`${PHONE_SHORTCUT_NAME}.lnk`)}; ` +
          `$shortcut = $shell.CreateShortcut($path); ` +
          `$shortcut.TargetPath = ${psQuote(paths.programsExePath)}; ` +
          `$shortcut.Arguments = 'network open'; $shortcut.Save()`,
      );
    },

    async openFirewallToHome(ports: readonly number[]) {
      // The old rule goes first inside the same elevated helper, so
      // opening again replaces the rule instead of adding a second
      // one, and the person still sees only one Windows prompt.
      const argumentList =
        `/c netsh advfirewall firewall delete rule name="${FIREWALL_RULE_NAME}" >nul 2>&1 & ` +
        `netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow ` +
        `protocol=TCP localport=${ports.join(',')} profile=private`;
      const exitCode = await runElevatedNetsh(argumentList);
      if (exitCode !== 0) {
        throw new WindowsJobError('the firewall rule could not be made');
      }
    },

    async closeFirewallToHome() {
      const argumentList = `/c netsh advfirewall firewall set rule name="${FIREWALL_RULE_NAME}" new enable=no`;
      const exitCode = await runElevatedNetsh(argumentList);
      if (exitCode === 0) {
        return;
      }
      // The set command also fails when there is no rule to turn off,
      // which is the closed state already: only a rule that is really
      // there makes this a failure. Reading the rules needs no prompt.
      const shown = await runner.run('netsh', [
        'advfirewall',
        'firewall',
        'show',
        'rule',
        `name=${FIREWALL_RULE_NAME}`,
      ]);
      if (shown.started && shown.exitCode === 0) {
        throw new WindowsJobError('the firewall rule could not be turned off');
      }
    },

    async replaceSetupCmdCopyWithForwarder() {
      try {
        await writeFile(paths.setupCmdCopyPath, SETUP_CMD_FORWARDER, 'utf8');
      } catch (error) {
        throw new WindowsJobError('the forwarder could not be written over the Aman Setup copy', { cause: error });
      }
    },

    async writeCaCertificate(certText: string) {
      try {
        await writeFile(paths.caCertPath, certText, 'utf8');
      } catch (error) {
        throw new WindowsJobError('the certificate file could not be written', { cause: error });
      }
    },

    async addCaCertificateToUserStore() {
      const result = await runner.run('certutil', ['-addstore', '-user', 'Root', paths.caCertPath]);
      if (!result.started || result.exitCode !== 0) {
        throw new WindowsJobError('the certificate could not be added to the store of this computer');
      }
    },

    async startDockerDesktop() {
      await runPowerShell(`Start-Process -FilePath ${psQuote(DOCKER_DESKTOP_EXE)}`);
    },

    async openBrowser(url: string) {
      await runPowerShell(`Start-Process ${psQuote(url)}`);
    },

    async makeFolderPrivate(path: string) {
      const user = await currentUserName();
      const result = await runner.run('icacls', [path, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`]);
      if (!result.started || result.exitCode !== 0) {
        throw new WindowsJobError(`the folder could not be made private: ${path}`);
      }
    },

    async readFolderAcl(path: string) {
      const owner = await currentUserName();
      const result = await runner.run('icacls', [path]);
      if (!result.started) {
        return { status: 'unreadable' };
      }
      if (result.exitCode !== 0) {
        const said = `${result.stdout}\n${result.stderr}`.toLowerCase();
        return said.includes('cannot find') ? { status: 'missing' } : { status: 'unreadable' };
      }
      return { status: 'read', owner, entries: parseAclListing({ path, text: result.stdout }) };
    },

    async portIsFree(port: number) {
      if (!(await bindWorks('127.0.0.1', port))) {
        return false;
      }
      return bindWorks('0.0.0.0', port);
    },
  };
}
