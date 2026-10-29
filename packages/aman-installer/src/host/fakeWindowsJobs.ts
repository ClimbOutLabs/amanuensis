import { win32 } from 'node:path';

import {
  CHECK_AMAN_SHORTCUT_NAME,
  SETUP_CMD_FORWARDER,
  UPDATE_AMAN_SHORTCUT_NAME,
  WindowsJobError,
  userPathHasFolder,
  windowsPaths,
  type ShortcutFacts,
  type WindowsJobs,
} from './windowsJobs.ts';

export type FakeWindowsJobStep =
  'copy' | 'path' | 'list' | 'point' | 'check' | 'update' | 'forwarder' | 'docker' | 'browser';

// A Windows host for tests: the user PATH, the shortcuts and the held
// ports are held in memory, every job writes down that it ran, and
// nothing on the real computer is touched.
export class FakeWindowsJobs implements WindowsJobs {
  readonly programsExePath: string;
  readonly setupCmdCopyPath: string;
  private readonly selfExePath: string;
  private readonly programsDir: string;
  private readonly startMenuProgramsDir: string;
  private readonly heldPorts: ReadonlySet<number>;
  private readonly failSteps: ReadonlySet<FakeWindowsJobStep>;
  userPath: string;
  shortcuts: ShortcutFacts[];
  forwarderContents: string | null = null;
  browserUrls: string[] = [];
  dockerDesktopStarts = 0;
  readonly ops: string[] = [];

  constructor(options: {
    localAppDataDir: string;
    selfExePath: string;
    startMenuProgramsDir: string;
    userPath?: string;
    shortcuts?: readonly ShortcutFacts[];
    heldPorts?: ReadonlySet<number>;
    failSteps?: ReadonlySet<FakeWindowsJobStep>;
  }) {
    const paths = windowsPaths(options.localAppDataDir);
    this.programsExePath = paths.programsExePath;
    this.setupCmdCopyPath = paths.setupCmdCopyPath;
    this.programsDir = paths.programsDir;
    this.selfExePath = options.selfExePath;
    this.startMenuProgramsDir = options.startMenuProgramsDir;
    this.userPath = options.userPath ?? '';
    this.shortcuts = [...(options.shortcuts ?? [])];
    this.heldPorts = options.heldPorts ?? new Set();
    this.failSteps = options.failSteps ?? new Set();
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

  replaceSetupCmdCopyWithForwarder(): Promise<void> {
    this.step('forwarder');
    this.forwarderContents = SETUP_CMD_FORWARDER;
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

  portIsFree(port: number): Promise<boolean> {
    return Promise.resolve(!this.heldPorts.has(port));
  }
}
