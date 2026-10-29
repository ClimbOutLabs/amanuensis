import { win32 } from 'node:path';

import {
  BACKUPS_SHORTCUT_NAME,
  CHECK_AMAN_SHORTCUT_NAME,
  PHONE_SHORTCUT_NAME,
  RUN_ONCE_VALUE_NAME,
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
  | 'phone'
  | 'firewall-open'
  | 'firewall-close'
  | 'forwarder'
  | 'ca-write'
  | 'ca-store'
  | 'docker'
  | 'browser'
  | 'aclPrivate'
  | 'aclRead'
  | 'installerWrite'
  | 'signer'
  | 'runOnceSet'
  | 'runOnceQuery'
  | 'runOnceClear'
  | 'awake'
  | 'pageWrite';

// A Windows host for tests: the user PATH, the shortcuts and the held
// ports are held in memory, every job writes down that it ran, and
// nothing on the real computer is touched.
export class FakeWindowsJobs implements WindowsJobs {
  readonly programsExePath: string;
  readonly setupCmdCopyPath: string;
  readonly dataDir: string;
  readonly backupsDir: string;
  readonly dockerDesktopInstallerPath: string;
  readonly gettingStartedPath: string;
  private readonly selfExePath: string;
  private readonly programsDir: string;
  private readonly startMenuProgramsDir: string;
  private readonly heldPorts: ReadonlySet<number>;
  private readonly failSteps: ReadonlySet<FakeWindowsJobStep>;
  private readonly aclOwner: string;
  private readonly acls: Map<string, AclRead>;
  private readonly scriptedSigner: string | null;
  userPath: string;
  installerBytes: Uint8Array | null = null;
  gettingStartedText: string | null = null;
  runOncePending: boolean;
  // The resume entry's value name, as the registry would hold it;
  // null when there is no entry. The fake models what Windows does
  // with the entry at the launch (launchFromRunOnce), so a test can
  // present the resumed run with the state a real computer presents.
  private runOnceValueName: string | null;
  awakeRequests = 0;
  shortcuts: ShortcutFacts[];
  forwarderContents: string | null = null;
  caCertContents: string | null = null;
  browserUrls: string[] = [];
  dockerDesktopStarts = 0;
  firewallOpen = false;
  firewallPorts: readonly number[] = [];
  backupTask: boolean;
  backupNames: string[];
  firewallOpen = false;
  firewallPorts: readonly number[] = [];
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
    // Who the saved Docker Desktop installer's signature names, as a
    // test scripts it; the default is Docker Inc.
    installerSigner?: string | null;
    // Whether the resume entry is set when the run starts, as a test
    // scripts it (a run the computer's restart reopened). The entry
    // is set under the name the jobs use, unless a test names another
    // one (an entry written without the leading "!", say).
    runOncePending?: boolean;
    runOnceValueName?: string;
  }) {
    const paths = windowsPaths(options.localAppDataDir);
    this.programsExePath = paths.programsExePath;
    this.setupCmdCopyPath = paths.setupCmdCopyPath;
    this.dataDir = paths.dataDir;
    this.backupsDir = paths.backupsDir;
    this.dockerDesktopInstallerPath = paths.dockerDesktopInstallerPath;
    this.gettingStartedPath = paths.gettingStartedPath;
    this.scriptedSigner =
      options.installerSigner === undefined
        ? 'CN=Docker Inc, O=Docker Inc, L=San Francisco, S=California, C=US'
        : options.installerSigner;
    this.runOnceValueName = options.runOnceValueName ?? (options.runOncePending === true ? RUN_ONCE_VALUE_NAME : null);
    this.runOncePending = this.runOnceValueName !== null;
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

  writeDockerDesktopInstaller(bytes: Uint8Array): Promise<void> {
    this.step('installerWrite');
    this.installerBytes = bytes;
    return Promise.resolve();
  }

  dockerDesktopInstallerSigner(): Promise<string | null> {
    this.step('signer');
    return Promise.resolve(this.scriptedSigner);
  }

  ensureRunOnceResume(): Promise<void> {
    this.step('runOnceSet');
    this.runOnceValueName = RUN_ONCE_VALUE_NAME;
    this.runOncePending = true;
    return Promise.resolve();
  }

  runOnceResumePending(): Promise<boolean> {
    this.step('runOnceQuery');
    return Promise.resolve(this.runOnceValueName !== null);
  }

  clearRunOnceResume(): Promise<void> {
    this.step('runOnceClear');
    this.runOnceValueName = null;
    this.runOncePending = false;
    return Promise.resolve();
  }

  // What Windows does when it opens the program the resume entry
  // names at a sign-in: the entry is taken down before the program
  // runs, so a resumed run finds no entry at all, unless the value
  // name starts with "!", which holds the taking-down off and the
  // entry stays there for the run to see and, in time, to clear.
  // A test calls this between scripting the entry and starting the
  // resumed run, so the run meets the state a real computer presents.
  launchFromRunOnce(): void {
    if (this.runOnceValueName !== null && !this.runOnceValueName.startsWith('!')) {
      this.runOnceValueName = null;
      this.runOncePending = false;
    }
  }

  keepComputerAwake(): Promise<void> {
    this.step('awake');
    this.awakeRequests += 1;
    return Promise.resolve();
  }

  writeGettingStartedPage(text: string): Promise<void> {
    this.step('pageWrite');
    this.gettingStartedText = text;
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
