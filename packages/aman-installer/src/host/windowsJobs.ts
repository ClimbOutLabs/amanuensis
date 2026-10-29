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
  | { status: 'read'; owner: string; entries: readonly AclEntry[] }
  | { status: 'missing' }
  | { status: 'unreadable' };

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
    const canRead = !groups.includes('DENY') && groups.some(group => group.split(',').some(part => ACL_READ_TOKENS.has(part.trim())));
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

  return {
    programsExePath: paths.programsExePath,
    setupCmdCopyPath: paths.setupCmdCopyPath,
    dataDir: paths.dataDir,

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
