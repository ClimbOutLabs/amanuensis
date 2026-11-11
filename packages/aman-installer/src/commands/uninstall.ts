import type { Host } from '../host/host.ts';
import type { WindowsJobs } from '../host/windowsJobs.ts';
import {
  BACKUP_SAVED_LINE,
  UNINSTALL_BACKUP_FAILED,
  UNINSTALL_BUSY,
  UNINSTALL_DECLINED_LINE,
  UNINSTALL_DOCKER_GONE_LINE,
  UNINSTALL_DOCKER_KEPT_LINE,
  UNINSTALL_DOCKER_LEFTOVERS,
  UNINSTALL_DOCKER_NOT_ANSWERING,
  UNINSTALL_DONE_LINE,
  UNINSTALL_IMAGE_UNAVAILABLE,
  UNINSTALL_NOT_WINDOWS,
  UNINSTALL_PLAN_LINES,
  UNINSTALL_QUESTION,
  UNINSTALL_STATE_UNREADABLE,
  problemText,
  uninstallBackupsKeptLine,
  uninstallBackupsQuestion,
  uninstallInstanceFailedProblem,
  uninstallRemovingInstanceLine,
  uninstallWindowsLeftoversProblem,
} from '../messages.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import { StateDockerError, StateImageError, type StateStore, type StateSummary } from '../state/state.ts';
import { SETUP_IMAGE, SOURCE_DIR, SOURCE_VOLUME, STATE_VOLUME, VOLUME_HOME } from '../state/volumeBackend.ts';
import { runBackup } from './backup.ts';

export interface UninstallDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
  jobs: WindowsJobs;
  print: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
}

// Every volume and every image Aman makes carries one of these name
// starts: the instances' and the shared services' volumes, the state
// and source volumes, and the images the install builds locally.
const VOLUME_PREFIX = 'aman_';
const IMAGE_PREFIX = 'aman-';

function printOutput(print: (line: string) => void, text: string): void {
  for (const line of text.split('\n')) {
    if (line.trim() !== '') {
      print(line);
    }
  }
}

// What the Docker side holds: the summary, nothing at all when Docker
// Desktop has been taken off the computer (its own removal deletes
// everything Aman kept in it), or null when it cannot be read, said.
async function readSummary(deps: UninstallDeps): Promise<StateSummary | 'docker-gone' | null> {
  try {
    const summary = await deps.store.readSummary();
    if (summary.releaseUnreadable) {
      deps.print(problemText(UNINSTALL_STATE_UNREADABLE));
      return null;
    }
    return summary;
  } catch (error) {
    if (error instanceof StateDockerError) {
      const version = await deps.runner.run('docker', ['--version']);
      if (!version.started) {
        return 'docker-gone';
      }
      deps.print(problemText(UNINSTALL_DOCKER_NOT_ANSWERING));
    } else if (error instanceof StateImageError) {
      deps.print(problemText(UNINSTALL_IMAGE_UNAVAILABLE));
    } else {
      deps.print(problemText(UNINSTALL_STATE_UNREADABLE));
    }
    return null;
  }
}

// One instance, removed by the shell's own removal in the setup
// container, data and all: its containers, sandboxes, volumes and
// records, and with the last instance the shared services and the
// daily backup schedule.
async function removeInstance(deps: UninstallDeps, name: string): Promise<boolean> {
  const { runner, print } = deps;
  print(uninstallRemovingInstanceLine(name));
  const result = await runner.run('docker', [
    'run',
    '--rm',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${STATE_VOLUME}:${VOLUME_HOME}`,
    '-v',
    `${SOURCE_VOLUME}:${SOURCE_DIR}`,
    '-w',
    SOURCE_DIR,
    SETUP_IMAGE,
    'installer/install.sh',
    '--yes',
    'instance',
    'remove',
    name,
    '--purge-data',
    '--confirm-name',
    name,
  ]);
  if (!result.started) {
    print(problemText(UNINSTALL_DOCKER_NOT_ANSWERING));
    return false;
  }
  // The shell's own lines name the paths inside the container, which
  // mean nothing on Windows; they are shown only when they explain a
  // failure.
  if (result.exitCode === 0) {
    return true;
  }
  printOutput(print, result.stdout);
  printOutput(print, result.stderr);
  if (`${result.stdout}\n${result.stderr}`.includes('Another install is running right now')) {
    print(problemText(UNINSTALL_BUSY));
    return false;
  }
  print(problemText(uninstallInstanceFailedProblem(name)));
  return false;
}

// What is left in Docker once the instances are gone: the state and
// source volumes, anything an earlier removal kept, and the images.
// Each name is deleted on its own, so one that will not go does not
// keep the others.
async function removeDockerLeftovers(deps: UninstallDeps): Promise<boolean> {
  const { runner } = deps;
  let clean = true;
  const volumes = await runner.run('docker', ['volume', 'ls', '--quiet']);
  if (!volumes.started || volumes.exitCode !== 0) {
    return false;
  }
  for (const name of volumes.stdout.split('\n').map(line => line.trim())) {
    if (name.startsWith(VOLUME_PREFIX)) {
      const removed = await runner.run('docker', ['volume', 'rm', name]);
      clean &&= removed.started && removed.exitCode === 0;
    }
  }
  const images = await runner.run('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  if (!images.started || images.exitCode !== 0) {
    return false;
  }
  const names = images.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(name => name.startsWith(IMAGE_PREFIX) && !name.endsWith(':<none>'));
  for (const name of names) {
    const removed = await runner.run('docker', ['image', 'rm', name]);
    clean &&= removed.started && removed.exitCode === 0;
  }
  // The setup image goes last: every step above ran in it. It may
  // already be gone, which is not a failure.
  await runner.run('docker', ['image', 'rm', SETUP_IMAGE]);
  return clean;
}

// The Windows side, in an order that keeps a removal that stopped part
// way finishable. First the steps that can meet a Windows prompt (the
// firewall rule, the certificate) along with the backup task and the
// resume entry: each is tried, and if any is left nothing else goes.
// Then the data folder, which the certificate is found through, then
// the PATH entry, and last the Start menu entries, among them Remove
// Aman itself. The folder the command lives in goes only after all of
// those.
async function removeWindowsSide(deps: UninstallDeps, keepBackups: boolean): Promise<boolean> {
  const { jobs } = deps;
  const ours = new Set([jobs.programsExePath, jobs.backupsDir, jobs.setupCmdCopyPath].map(path => path.toLowerCase()));
  const attempt = async (step: () => Promise<void>): Promise<boolean> => {
    try {
      await step();
      return true;
    } catch {
      return false;
    }
  };
  const first = [
    await attempt(() => jobs.removeDailyBackupTask()),
    await attempt(async () => {
      if (await jobs.runOnceResumePending()) {
        await jobs.clearRunOnceResume();
      }
    }),
    await attempt(() => jobs.removeFirewallRule()),
    await attempt(() => jobs.removeCaCertificateFromUserStore()),
  ];
  if (first.includes(false)) {
    return false;
  }
  const last: (() => Promise<void>)[] = [
    () => jobs.removeDataFolder({ keepBackups }),
    () => jobs.removeProgramsFolderFromUserPath(),
    async () => {
      for (const shortcut of await jobs.listShortcuts()) {
        if (ours.has(shortcut.target.toLowerCase())) {
          await jobs.removeShortcut(shortcut.path);
        }
      }
    },
    () => jobs.removeProgramsFolderAfterExit(),
  ];
  for (const step of last) {
    if (!(await attempt(step))) {
      return false;
    }
  }
  return true;
}

// The Docker side: a last backup when the backups are kept, every
// instance, then what is left in Docker. A note beside the aman command
// records that it is done, so a run that only has the Windows side left
// does not need Docker.
async function removeDockerSide(
  deps: UninstallDeps,
  options: { summary: StateSummary; keepBackups: boolean },
): Promise<boolean> {
  const { print, jobs } = deps;
  const { summary, keepBackups } = options;
  if (keepBackups && summary.instances.length > 0) {
    // The backup's own pointer to the Backups entry is left out: that
    // entry is about to go, and the closing lines name the folder.
    const backupCode = await runBackup({
      ...deps,
      print: line => {
        if (line !== BACKUP_SAVED_LINE) {
          print(line);
        }
      },
    });
    if (backupCode !== 0) {
      print(problemText(UNINSTALL_BACKUP_FAILED));
      return false;
    }
  }
  for (const instance of summary.instances) {
    if (!(await removeInstance(deps, instance.name))) {
      return false;
    }
  }
  if (!(await removeDockerLeftovers(deps))) {
    print(problemText(UNINSTALL_DOCKER_LEFTOVERS));
    return false;
  }
  // Without the note the next run only asks for Docker again.
  await jobs.markDockerSideRemoved().catch(() => undefined);
  return true;
}

// aman uninstall: removes Aman from a Windows computer, after one
// question that names everything it deletes. Backups are kept, with a
// last one made first, unless the second question is answered yes.
// Docker Desktop stays: it is its own program, and other programs may
// use it.
export async function runUninstall(deps: UninstallDeps): Promise<number> {
  const { host, jobs, print, confirm } = deps;
  if (host.kind !== 'windows') {
    print(problemText(UNINSTALL_NOT_WINDOWS));
    return 1;
  }
  const dockerDone = await jobs.dockerSideRemoved();
  const docker = dockerDone ? 'docker-gone' : await readSummary(deps);
  if (docker === null) {
    return 1;
  }
  if (docker === 'docker-gone' && !dockerDone) {
    print(UNINSTALL_DOCKER_GONE_LINE);
  }
  for (const line of UNINSTALL_PLAN_LINES) {
    print(line);
  }
  if (!(await confirm(UNINSTALL_QUESTION))) {
    print(UNINSTALL_DECLINED_LINE);
    return 0;
  }
  const keepBackups = !(await confirm(uninstallBackupsQuestion(jobs.backupsDir)));
  if (docker !== 'docker-gone' && !(await removeDockerSide(deps, { summary: docker, keepBackups }))) {
    return 1;
  }
  if (!(await removeWindowsSide(deps, keepBackups))) {
    print(problemText(uninstallWindowsLeftoversProblem(jobs.programsExePath)));
    return 1;
  }
  print(UNINSTALL_DONE_LINE);
  if (keepBackups) {
    print(uninstallBackupsKeptLine(jobs.backupsDir));
  }
  print(UNINSTALL_DOCKER_KEPT_LINE);
  return 0;
}
