import type { Host } from '../host/host.ts';
import type { WindowsJobs } from '../host/windowsJobs.ts';
import {
  ADOPTED_LINE,
  ADOPT_DOCKER_NOT_ANSWERING,
  ADOPT_IMAGE_UNAVAILABLE,
  ADOPT_NOT_INSTALLED,
  ADOPT_NOT_WINDOWS,
  ADOPT_SETUP_FAILED,
  ADOPT_STATE_UNREADABLE,
  problemText,
} from '../messages.ts';
import { StateDockerError, StateImageError, type StateStore, type StateSummary } from '../state/state.ts';

export interface AdoptDeps {
  host: Host;
  store: StateStore;
  jobs: WindowsJobs;
  print: (line: string) => void;
}

// aman adopt: a PC set up with the Aman Setup download gets the aman
// command. Finding the install goes through the state store's read
// only: adopt takes no state write and no volume lock, and changes no
// data and no state file. What it writes is on the Windows side: the
// program copy, one user PATH value, the shortcuts and the forwarder
// over the starter's copy of Aman-Setup.cmd.
export async function runAdopt(deps: AdoptDeps): Promise<number> {
  const { host, store, jobs, print } = deps;
  if (host.kind !== 'windows') {
    print(problemText(ADOPT_NOT_WINDOWS));
    return 1;
  }
  let summary: StateSummary;
  try {
    summary = await store.readSummary();
  } catch (error) {
    if (error instanceof StateDockerError) {
      print(problemText(ADOPT_DOCKER_NOT_ANSWERING));
      return 1;
    }
    if (error instanceof StateImageError) {
      print(problemText(ADOPT_IMAGE_UNAVAILABLE));
      return 1;
    }
    print(problemText(ADOPT_STATE_UNREADABLE));
    return 1;
  }
  if (summary.releaseUnreadable) {
    print(problemText(ADOPT_STATE_UNREADABLE));
    return 1;
  }
  if (summary.release === null && summary.instances.length === 0) {
    print(problemText(ADOPT_NOT_INSTALLED));
    return 1;
  }
  try {
    await jobs.copySelfToPrograms();
    await jobs.ensureProgramsFolderOnUserPath();
    const shortcuts = await jobs.listShortcuts();
    for (const shortcut of shortcuts) {
      // The starter's shortcuts point at its copy of Aman-Setup.cmd and
      // pass it "open"; those, and only those, move to the aman command.
      if (
        shortcut.target.toLowerCase() === jobs.setupCmdCopyPath.toLowerCase() &&
        shortcut.args.trim().toLowerCase() === 'open'
      ) {
        await jobs.pointShortcutAtOpen(shortcut.path);
      }
    }
    await jobs.ensureCheckAmanShortcut();
    await jobs.replaceSetupCmdCopyWithForwarder();
  } catch {
    print(problemText(ADOPT_SETUP_FAILED));
    return 1;
  }
  print(ADOPTED_LINE);
  return 0;
}
