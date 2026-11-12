import type { Host } from '../host/host.ts';
import type { WindowsJobs } from '../host/windowsJobs.ts';
import {
  BACKUP_BUSY,
  BACKUP_DOCKER_NOT_ANSWERING,
  BACKUP_FAILED,
  BACKUP_IMAGE_UNAVAILABLE,
  BACKUP_NOT_INSTALLED,
  BACKUP_NOT_WINDOWS,
  BACKUP_SAVED_LINE,
  BACKUP_STATE_UNREADABLE,
  problemText,
} from '../messages.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import { StateDockerError, StateImageError, type StateStore, type StateSummary } from '../state/state.ts';
import { SETUP_IMAGE, SOURCE_DIR, SOURCE_VOLUME, STATE_VOLUME, VOLUME_HOME } from '../state/volumeBackend.ts';

export interface BackupDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
  jobs: WindowsJobs;
  print: (line: string) => void;
}

// aman backup: make a backup now, on Windows. The work is the shell's
// own backup, run in the setup container with the upgrade's container
// shape, plus one mount: the backups folder on the Windows disk sits
// where the shell writes its backups, so the backup lands on the disk,
// inside the folder the doctor's files check guards, and the shell's
// own keep-the-last-seven pruning rules that folder. The shell takes
// the state lock in there. The daily task runs this same command.
export async function runBackup(deps: BackupDeps): Promise<number> {
  const { host, runner, store, jobs, print } = deps;
  if (host.kind !== 'windows') {
    print(problemText(BACKUP_NOT_WINDOWS));
    return 1;
  }
  let summary: StateSummary;
  try {
    summary = await store.readSummary();
  } catch (error) {
    if (error instanceof StateDockerError) {
      print(problemText(BACKUP_DOCKER_NOT_ANSWERING));
      return 1;
    }
    if (error instanceof StateImageError) {
      print(problemText(BACKUP_IMAGE_UNAVAILABLE));
      return 1;
    }
    print(problemText(BACKUP_STATE_UNREADABLE));
    return 1;
  }
  if (summary.releaseUnreadable) {
    print(problemText(BACKUP_STATE_UNREADABLE));
    return 1;
  }
  if (summary.release === null && summary.instances.length === 0) {
    print(problemText(BACKUP_NOT_INSTALLED));
    return 1;
  }
  const result = await runner.run('docker', [
    'run',
    '--rm',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${STATE_VOLUME}:${VOLUME_HOME}`,
    '-v',
    `${SOURCE_VOLUME}:${SOURCE_DIR}`,
    '-v',
    `${jobs.backupsDir}:${VOLUME_HOME}/backups`,
    '-w',
    SOURCE_DIR,
    SETUP_IMAGE,
    'installer/install.sh',
    'backup',
  ]);
  if (!result.started) {
    print(problemText(BACKUP_DOCKER_NOT_ANSWERING));
    return 1;
  }
  for (const line of result.stdout.split('\n')) {
    if (line.trim() !== '') {
      print(line);
    }
  }
  for (const line of result.stderr.split('\n')) {
    if (line.trim() !== '') {
      print(line);
    }
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === 0) {
    // An install whose instances were all removed answers that there
    // is nothing to back up, in its own words, and saves nothing.
    if (!combined.includes('nothing to back up')) {
      print(BACKUP_SAVED_LINE);
    }
    return 0;
  }
  if (combined.includes('Another install is running right now')) {
    print(problemText(BACKUP_BUSY));
    return 1;
  }
  print(problemText(BACKUP_FAILED));
  return 1;
}
