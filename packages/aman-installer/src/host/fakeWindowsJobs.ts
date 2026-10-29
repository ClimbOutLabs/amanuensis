import { win32 } from 'node:path';

import {
  BACKUPS_SHORTCUT_NAME,
  CHECK_AMAN_SHORTCUT_NAME,
  PHONE_SHORTCUT_NAME,
  SETUP_CMD_FORWARDER,
  UPDATE_AMAN_SHORTCUT_NAME,
  WindowsJobError,
  userPathHasFolder,
  windowsPaths,
  type AclRead,
  type ShortcutFacts,
  type WindowsJobs,
} from './windowsJobs.ts';

export type FakeWindowsJobStep =
  | 'copy'
  | 'path'
  | 'list'
  | 'point'
  | 'check'
  | 'update'
  | 'phone'
  | 'firewall-open'
  | 'firewall-close'
  | 'backupsShortcut'
  | 'task'
  | 'taskQuery'
  | 'backupsList'
  | 'forwarder'
  | 'ca-write'
  | 'ca-store'
  | 'docker'
  | 'browser'
  | 'aclPrivate'
  | 'aclRead';

// A Windows host for tests: the user PATH, the shortcuts and the held
// ports are held in memory, every job writes down that it ran, and
// nothing on the real computer is touched.
export class FakeWindowsJobs implements WindowsJobs {
  readonly programsExePath: string;
  readonly setupCmdCopyPath: string;
  readonly dataDir: string;
  readonly backupsDir: string;
  private readonly selfExePath: string;
  private readonly programsDir: string;
  private readonly startMenuProgramsDir: string;
  private readonly heldPorts: ReadonlySet<number>;
  private readonly failSteps: ReadonlySet<FakeWindowsJobStep>;
  private readonly aclOwner: string;
  private readonly acls: Map<string, AclRead>;
  userPath: string;
  shortcuts: ShortcutFacts[];
  forwarderContents: string | null = null;
  caCertContents: string | null = null;
  browserUrls: string[] = [];
  dockerDesktopStarts = 0;
  firewallOpen = false;
  firewallPorts: readonly number[] = [];
  backupTask: boolean;
  backupNames: string[];
  readonly ops: string[] = [];

  constructor(options: {
    localAppDataDir: string;
    selfExePath: string;
    startMenuProgramsDir: string;
    userPath?: string;
    shortcuts?: readonly ShortcutFacts[];
    heldPorts?: ReadonlySet<number>;
    failSteps?: ReadonlySet<FakeWindowsJobStep>;
    // The person's own account name, as an access list prints it, and
    // the access lists tests start folders with. A folder with no list
    // scripted is not there.
    aclOwner?: string;
    acls?: ReadonlyMap<string, AclRead>;
    // Whether the daily backup task is there, and the names in the
    // backups folder, as a test scripts them.
    backupTask?: boolean;
    backups?: readonly string[];
  }) {
    const paths = windowsPaths(options.localAppDataDir);
    this.programsExePath = paths.programsExePath;
    this.setupCmdCopyPath = paths.setupCmdCopyPath;
    this.dataDir = paths.dataDir;
    this.backupsDir = paths.backupsDir;
    this.programsDir = paths.programsDir;
    this.selfExePath = options.selfExePath;
    this.startMenuProgramsDir = options.startMenuProgramsDir;
    this.userPath = options.userPath ?? '';
    this.shortcuts = [...(options.shortcuts ?? [])];
    this.heldPorts = options.heldPorts ?? new Set();
    this.failSteps = options.failSteps ?? new Set();
    this.aclOwner = options.aclOwner ?? 'FRIEND-PC\\Friend';
    this.acls = new Map(options.acls ?? []);
    this.backupTask = options.backupTask ?? false;
    this.backupNames = [...(options.backups ?? [])];
  }

  private step(name: FakeWindowsJobStep): void {
    this.ops.push(name);
    if (this.failSteps.has(name)) {
      throw new WindowsJobError(`the ${name} step failed, as the test asked`);
    }
  }

  copySelfToPrograms(): Promise<'copied' | 'already'> {
    this.step('copy');
    if (this.selfExePath.toLowerCase() === this.programsExePath.toLowerCase()) {
      return Promise.resolve('already');
    }
    return Promise.resolve('copied');
  }

  ensureProgramsFolderOnUserPath(): Promise<'added' | 'present'> {
    this.step('path');
    if (userPathHasFolder({ pathValue: this.userPath, folder: this.programsDir })) {
      return Promise.resolve('present');
    }
    this.userPath =
      this.userPath.trim() === '' ? this.programsDir : `${this.userPath.replace(/;+$/, '')};${this.programsDir}`;
    return Promise.resolve('added');
  }

  listShortcuts(): Promise<readonly ShortcutFacts[]> {
    this.step('list');
    return Promise.resolve(this.shortcuts);
  }

  pointShortcutAtOpen(shortcutPath: string): Promise<void> {
    this.step('point');
    this.shortcuts = this.shortcuts.map(shortcut =>
      shortcut.path === shortcutPath ? { ...shortcut, target: this.programsExePath, args: 'open' } : shortcut,
    );
    return Promise.resolve();
  }

  ensureCheckAmanShortcut(): Promise<void> {
    this.step('check');
    const path = win32.join(this.startMenuProgramsDir, `${CHECK_AMAN_SHORTCUT_NAME}.lnk`);
    const entry: ShortcutFacts = { path, target: this.programsExePath, args: 'doctor' };
    const existing = this.shortcuts.findIndex(shortcut => shortcut.path === path);
    if (existing === -1) {
      this.shortcuts.push(entry);
    } else {
      this.shortcuts[existing] = entry;
    }
    return Promise.resolve();
  }

  ensureUpdateAmanShortcut(): Promise<void> {
    this.step('update');
    const path = win32.join(this.startMenuProgramsDir, `${UPDATE_AMAN_SHORTCUT_NAME}.lnk`);
    const entry: ShortcutFacts = { path, target: this.programsExePath, args: 'upgrade' };
    const existing = this.shortcuts.findIndex(shortcut => shortcut.path === path);
    if (existing === -1) {
      this.shortcuts.push(entry);
    } else {
      this.shortcuts[existing] = entry;
    }
    return Promise.resolve();
  }

  ensurePhoneShortcut(): Promise<void> {
    this.step('phone');
    const path = win32.join(this.startMenuProgramsDir, `${PHONE_SHORTCUT_NAME}.lnk`);
    const entry: ShortcutFacts = { path, target: this.programsExePath, args: 'network open' };
    const existing = this.shortcuts.findIndex(shortcut => shortcut.path === path);
    if (existing === -1) {
      this.shortcuts.push(entry);
    } else {
      this.shortcuts[existing] = entry;
    }
    return Promise.resolve();
  }

  openFirewallToHome(ports: readonly number[]): Promise<void> {
    this.step('firewall-open');
    this.firewallOpen = true;
    this.firewallPorts = [...ports];
    return Promise.resolve();
  }

  closeFirewallToHome(): Promise<void> {
    this.step('firewall-close');
    this.firewallOpen = false;
    return Promise.resolve();
  }

  ensureBackupsShortcut(): Promise<void> {
    this.step('backupsShortcut');
    const path = win32.join(this.startMenuProgramsDir, `${BACKUPS_SHORTCUT_NAME}.lnk`);
    const entry: ShortcutFacts = { path, target: this.backupsDir, args: '' };
    const existing = this.shortcuts.findIndex(shortcut => shortcut.path === path);
    if (existing === -1) {
      this.shortcuts.push(entry);
    } else {
      this.shortcuts[existing] = entry;
    }
    return Promise.resolve();
  }

  ensureDailyBackupTask(): Promise<void> {
    this.step('task');
    this.backupTask = true;
    return Promise.resolve();
  }

  dailyBackupTaskPresent(): Promise<boolean> {
    this.step('taskQuery');
    return Promise.resolve(this.backupTask);
  }

  listBackups(): Promise<readonly string[]> {
    this.step('backupsList');
    return Promise.resolve([...this.backupNames]);
  }

  replaceSetupCmdCopyWithForwarder(): Promise<void> {
    this.step('forwarder');
    this.forwarderContents = SETUP_CMD_FORWARDER;
    return Promise.resolve();
  }

  writeCaCertificate(certText: string): Promise<void> {
    this.step('ca-write');
    this.caCertContents = certText;
    return Promise.resolve();
  }

  addCaCertificateToUserStore(): Promise<void> {
    this.step('ca-store');
    return Promise.resolve();
  }

  startDockerDesktop(): Promise<void> {
    this.step('docker');
    this.dockerDesktopStarts += 1;
    return Promise.resolve();
  }

  openBrowser(url: string): Promise<void> {
    this.step('browser');
    this.browserUrls.push(url);
    return Promise.resolve();
  }

  // Making a folder private leaves it with one entry, the person's
  // own, as the real command leaves it.
  makeFolderPrivate(path: string): Promise<void> {
    this.step('aclPrivate');
    this.acls.set(path, {
      status: 'read',
      owner: this.aclOwner,
      entries: [{ principal: this.aclOwner, canRead: true }],
    });
    return Promise.resolve();
  }

  readFolderAcl(path: string): Promise<AclRead> {
    this.step('aclRead');
    return Promise.resolve(this.acls.get(path) ?? { status: 'missing' });
  }

  portIsFree(port: number): Promise<boolean> {
    return Promise.resolve(!this.heldPorts.has(port));
  }
}
