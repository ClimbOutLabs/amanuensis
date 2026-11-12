import { win32 } from 'node:path';

import type { Host } from '../host/host.ts';
import type { WindowsJobs } from '../host/windowsJobs.ts';
import {
  RESTORE_BOTH_GIVEN,
  RESTORE_BUSY,
  RESTORE_CHOICE_QUESTION,
  RESTORE_COULD_NOT_LIST,
  RESTORE_DECLINED_LINE,
  RESTORE_DOCKER_NOT_ANSWERING,
  RESTORE_FAILED,
  RESTORE_IMAGE_UNAVAILABLE,
  RESTORE_LIST_HEADING_LINE,
  RESTORE_NOT_A_CHOICE,
  RESTORE_NOT_INSTALLED,
  RESTORE_NOT_WINDOWS,
  RESTORE_NO_ANSWER,
  RESTORE_PASSWORD_LINE,
  RESTORE_REMOVAL_NOTE_STUCK,
  RESTORE_STATE_UNREADABLE,
  RESTORE_WORKING_LINE,
  RESTORE_YES_PROMPT,
  problemText,
  restoreChoiceLine,
  restoreNoBackupsProblem,
  restoreNoSuchBackupProblem,
  restoreNoSuchInstanceProblem,
  restoreQuestionLine,
  restoreUsageProblem,
  restoreWhichInstanceProblem,
  type Problem,
} from '../messages.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import { StateDockerError, StateImageError, type StateStore, type StateSummary } from '../state/state.ts';
import { SETUP_IMAGE, SOURCE_DIR, SOURCE_VOLUME, STATE_VOLUME, VOLUME_HOME } from '../state/volumeBackend.ts';
import { instanceState } from './status.ts';

export interface RestoreDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
  jobs: WindowsJobs;
  print: (line: string) => void;
  // A line typed in answer, or null when the input ended without one.
  ask: (question: string) => Promise<string | null>;
}

// What the person asked for, in the shell's own words: an instance name
// and a backup time in either order, or --latest. The same words work in
// both, so every next step the shell prints can be typed here as it is.
export interface RestoreRequest {
  name: string | null;
  backup: string | null;
  latest: boolean;
}

// A backup's folder name, as the shell names it: its time, a number
// when two were made in the same second, and the name of a kept backup.
const BACKUP_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}Z(?:-\d+)?(?:-([a-z][a-z-]*))?$/;

export function parseRestoreArgs(args: readonly string[]): RestoreRequest | Problem {
  let name: string | null = null;
  let backup: string | null = null;
  let latest = false;
  for (const arg of args) {
    if (arg === '--latest') {
      latest = true;
    } else if (BACKUP_NAME.test(arg) && backup === null) {
      backup = arg;
    } else if (!arg.startsWith('-') && !BACKUP_NAME.test(arg) && name === null) {
      name = arg;
    } else {
      return restoreUsageProblem(arg);
    }
  }
  if (latest && backup !== null) {
    return RESTORE_BOTH_GIVEN;
  }
  return { name, backup, latest };
}

// 20261017T031500Z-before-import -> 2026-10-17 03:15 UTC (before import)
export function backupLabel(backup: string): string {
  const match = BACKUP_NAME.exec(backup);
  if (match === null) {
    return backup;
  }
  const [, year, month, day, hour, minute, kept] = match;
  const when = `${year ?? ''}-${month ?? ''}-${day ?? ''} ${hour ?? ''}:${minute ?? ''} UTC`;
  return kept === undefined ? when : `${when} (${kept.replaceAll('-', ' ')})`;
}

// The shell's own question, already asked and answered here, is not
// shown a second time. Its prompt ends without a line break, because a
// person's answer would end it, so the shell's next words follow it on
// the same line and are kept.
const SHELL_QUESTION = [
  'This replaces the current chats and settings of ',
  'The password goes back to the one ',
  'A copy of the current state is saved first.',
];
const SHELL_PROMPT = /^.*Type yes to continue:\s*/;

// The shell prints the backups folder as the setup container mounts it;
// the person reads it as the folder on the PC.
function onThisPc({ line, backupsDir }: { line: string; backupsDir: string }): string {
  return line.replace(
    new RegExp(`${VOLUME_HOME.replaceAll('.', '\\.')}/backups(/[^\\s]*)?`, 'g'),
    (_whole: string, rest: string | undefined) =>
      rest === undefined ? backupsDir : win32.join(backupsDir, ...rest.split('/').filter(part => part !== '')),
  );
}

function show({ print, text, backupsDir }: { print: (line: string) => void; text: string; backupsDir: string }): void {
  for (const raw of text.split('\n')) {
    const line = raw.replace(SHELL_PROMPT, '');
    if (line.trim() !== '' && !SHELL_QUESTION.some(start => line.startsWith(start))) {
      print(onThisPc({ line, backupsDir }));
    }
  }
}

// The shell's own explanations, matched with its line wrapping undone.
const SHELL_EXPLAINED =
  /cannot be used because|There is no backup|was put back the way it was|could not be put back by itself|Nothing was changed|nothing was changed|No answer was given/;

// aman restore, on Windows: puts an instance back from a backup in the
// Backups folder on the PC. The exe picks the backup and asks the one
// question; the work is the shell's own restore, run in the setup
// container with the backup's container shape. The shell checks the
// backup, saves a copy of how the instance is now, puts the backup
// back, starts the instance, and puts the copy back if anything fails.
// Reading the backup happens in there too, so a backup format that
// needs a tool to open never needs that tool on Windows.
export async function runRestore(deps: RestoreDeps, request: RestoreRequest): Promise<number> {
  const { host, runner, store, jobs, print } = deps;
  if (host.kind !== 'windows') {
    print(problemText(RESTORE_NOT_WINDOWS));
    return 1;
  }
  let summary: StateSummary;
  try {
    summary = await store.readSummary();
  } catch (error) {
    if (error instanceof StateDockerError) {
      print(problemText(RESTORE_DOCKER_NOT_ANSWERING));
      return 1;
    }
    if (error instanceof StateImageError) {
      print(problemText(RESTORE_IMAGE_UNAVAILABLE));
      return 1;
    }
    print(problemText(RESTORE_STATE_UNREADABLE));
    return 1;
  }
  if (summary.releaseUnreadable) {
    print(problemText(RESTORE_STATE_UNREADABLE));
    return 1;
  }
  const names = summary.instances.map(instance => instance.name);
  if (names.length === 0) {
    print(problemText(RESTORE_NOT_INSTALLED));
    return 1;
  }
  let name: string;
  if (request.name !== null) {
    if (!names.includes(request.name)) {
      print(problemText(restoreNoSuchInstanceProblem(request.name)));
      return 1;
    }
    name = request.name;
  } else if (names.length === 1 && names[0] !== undefined) {
    name = names[0];
  } else {
    print(problemText(restoreWhichInstanceProblem(names)));
    return 1;
  }

  let backups: string[];
  try {
    backups = (await jobs.listBackups({ holding: name })).filter(backup => BACKUP_NAME.test(backup));
  } catch {
    print(problemText(RESTORE_COULD_NOT_LIST));
    return 1;
  }
  // The names begin with the time each backup was made, so sorting them
  // sorts the backups; newest first is the order a person reads.
  backups.sort().reverse();
  if (backups.length === 0) {
    print(problemText(restoreNoBackupsProblem({ name, folder: jobs.backupsDir })));
    return 1;
  }
  let backup: string;
  if (request.backup !== null) {
    if (!backups.includes(request.backup)) {
      print(problemText(restoreNoSuchBackupProblem(request.backup)));
      return 1;
    }
    backup = request.backup;
  } else if (request.latest && backups[0] !== undefined) {
    backup = backups[0];
  } else {
    print(RESTORE_LIST_HEADING_LINE);
    backups.forEach((each, index) => {
      print(restoreChoiceLine({ number: index + 1, label: backupLabel(each) }));
    });
    const typed = await deps.ask(RESTORE_CHOICE_QUESTION);
    if (typed === null) {
      print(problemText(RESTORE_NO_ANSWER));
      return 1;
    }
    const answer = typed.trim();
    const picked = /^\d+$/.test(answer) ? backups[Number(answer) - 1] : undefined;
    if (picked === undefined) {
      print(problemText(RESTORE_NOT_A_CHOICE));
      return 1;
    }
    backup = picked;
  }

  const running = (await instanceState(runner, name)) !== 'stopped';
  print(RESTORE_PASSWORD_LINE);
  const agreed = await deps.ask(
    `${restoreQuestionLine({ name, label: backupLabel(backup), running })} ${RESTORE_YES_PROMPT}`,
  );
  if (agreed === null) {
    print(problemText(RESTORE_NO_ANSWER));
    return 1;
  }
  if (!/^y(es)?$/i.test(agreed.trim())) {
    print(RESTORE_DECLINED_LINE);
    return 0;
  }
  // An earlier removal's note that Docker is cleared stops being true
  // once the restore brings an instance back.
  try {
    await jobs.clearDockerSideRemoved();
  } catch {
    print(problemText(RESTORE_REMOVAL_NOTE_STUCK));
    return 1;
  }
  print(RESTORE_WORKING_LINE);

  // The question was asked above, so the shell's own question is
  // answered yes on its input; it asks nothing else.
  const result = await runner.runBytes(
    'docker',
    [
      'run',
      '--rm',
      '-i',
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
      'restore',
      name,
      backup,
    ],
    new TextEncoder().encode('yes\n'),
  );
  if (!result.started) {
    print(problemText(RESTORE_DOCKER_NOT_ANSWERING));
    return 1;
  }
  const stdout = new TextDecoder().decode(result.stdout);
  show({ print, text: stdout, backupsDir: jobs.backupsDir });
  show({ print, text: result.stderr, backupsDir: jobs.backupsDir });
  if (result.exitCode === 0) {
    return 0;
  }
  const combined = `${stdout}\n${result.stderr}`.replace(/\s+/g, ' ');
  if (combined.includes('Another install is running right now')) {
    print(problemText(RESTORE_BUSY));
    return 1;
  }
  // The shell's refusals and its rollback each say what happened and
  // the one thing to do next, so only a failure it did not explain
  // gets this command's own words.
  if (!SHELL_EXPLAINED.test(combined)) {
    print(problemText(RESTORE_FAILED));
  }
  return 1;
}
