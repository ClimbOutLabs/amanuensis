import type { Host } from '../host/host.ts';
import type { WindowsJobs } from '../host/windowsJobs.ts';
import {
  BACKUPS_COULD_NOT_LIST,
  BACKUPS_NOT_WINDOWS,
  NO_BACKUPS_LINE,
  backupNameLine,
  backupsFolderLine,
  problemText,
} from '../messages.ts';

export interface BackupsDeps {
  host: Host;
  jobs: WindowsJobs;
  print: (line: string) => void;
}

// aman backups: the backups kept on this computer, newest first. They
// are the folders in the backups folder on the Windows disk, the
// folder the Backups entry in the Start menu opens.
export async function runBackups(deps: BackupsDeps): Promise<number> {
  const { host, jobs, print } = deps;
  if (host.kind !== 'windows') {
    print(problemText(BACKUPS_NOT_WINDOWS));
    return 1;
  }
  let names: readonly string[];
  try {
    names = await jobs.listBackups();
  } catch {
    print(problemText(BACKUPS_COULD_NOT_LIST));
    return 1;
  }
  if (names.length === 0) {
    print(NO_BACKUPS_LINE);
    return 0;
  }
  print(backupsFolderLine(jobs.backupsDir));
  // The names begin with the time each backup was made, so sorting
  // them sorts the backups; newest first is the order a person reads.
  for (const name of [...names].sort().reverse()) {
    print(backupNameLine(name));
  }
  return 0;
}
