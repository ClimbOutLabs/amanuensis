import type { SystemKind } from './host/host.ts';
import { LOCK_TIMING } from './state/lockTiming.ts';

// Every sentence a person can read lives in this file, as a Problem with two
// fields: what happened, and what to do (one sentence, one action). A test in
// tests/messages.test.ts fails the build when a message breaks the rules in
// the plan: plain words, no jargon, at most 40 words, one action.
export interface Problem {
  happened: string;
  fix: string;
}

export function problemText(problem: Problem): string {
  return `${problem.happened} ${problem.fix}`;
}

export function versionLine(version: string): string {
  return `aman ${version}`;
}

export const HELP_LINES: readonly string[] = [
  'Aman installer. It checks that Aman is set up well on this computer.',
  'Run aman --version to see which version this is.',
  'Run aman doctor to check this computer and each instance.',
  'Run aman doctor docker to check that Docker is ready for Aman.',
  'Run aman status to see what is installed and whether it is running.',
  'Run aman setup to set Aman up in your browser, step by step.',
];

export const DOCKER_NOT_INSTALLED: Record<SystemKind, Problem> = {
  darwin: {
    happened: 'Docker is not installed on this computer.',
    fix: 'Install Docker Desktop from its website, then run this check again.',
  },
  linux: {
    happened: 'Docker is not installed on this computer.',
    fix: 'Install Docker Engine from its website, then run this check again.',
  },
};

export const DOCKER_NOT_RUNNING: Record<SystemKind, Problem> = {
  darwin: {
    happened: 'Docker Desktop is not running.',
    fix: 'Open Docker Desktop from Launchpad, then run this check again.',
  },
  linux: {
    happened: 'Docker Engine is not running.',
    fix: 'Start Docker Engine on this computer, then run this check again.',
  },
};

export const COMPOSE_MISSING: Record<SystemKind, Problem> = {
  darwin: {
    happened: 'Docker is installed without its Compose tool, which Aman needs.',
    fix: 'Update Docker Desktop to the newest version, then run this check again.',
  },
  linux: {
    happened: 'Docker is installed without its Compose tool, which Aman needs.',
    fix: 'Install the Docker Compose add-on, then run this check again.',
  },
};

export const LOW_MEMORY: Record<SystemKind, Problem> = {
  darwin: {
    happened: 'Docker has less than 6 GB of memory to work with on this computer.',
    fix: 'Give Docker Desktop at least 6 GB of memory in its settings, then run this check again.',
  },
  linux: {
    happened: 'This computer gives Docker Engine less than 6 GB of memory to work with.',
    fix: 'Free up memory on this computer so Docker Engine can use at least 6 GB, then run this check again.',
  },
};

// Said when Docker does not report its memory at all. On a Mac the check
// fails with this instead of guessing from the whole computer's memory,
// which is not the memory Docker can use.
export const MEMORY_NOT_REPORTED: Record<SystemKind, Problem> = {
  darwin: {
    happened: 'Docker did not say how much memory it has to work with.',
    fix: 'Open Docker Desktop, check the memory in its settings, then run this check again.',
  },
  linux: {
    happened: 'Docker did not say how much memory it has to work with.',
    fix: 'Start Docker Engine again, then run this check again.',
  },
};

export const ENGINE_VERSION_MISSING: Problem = {
  happened: 'Docker did not say which Engine version it is running.',
  fix: 'Update Docker to the newest version, then run this check again.',
};

// The Engine floor the docker check holds every system to.
export const ENGINE_TOO_OLD: Record<SystemKind, Problem> = {
  darwin: {
    happened: "Docker Desktop is running an Engine that is too old for Aman's https on this computer.",
    fix: 'Update Docker Desktop to the newest version, then run this check again.',
  },
  linux: {
    happened: "Docker Engine is too old for Aman's https on this computer.",
    fix: 'Update Docker Engine to the newest version, then run this check again.',
  },
};

export function unknownCommandProblem(command: string): Problem {
  return {
    happened: `Aman does not know the command "${command}".`,
    fix: 'Run aman with no command to see what it can do.',
  };
}

export const UNKNOWN_DOCTOR_CHECK: Problem = {
  happened: 'That doctor check is not one Aman knows.',
  fix: 'Run aman doctor docker to check Docker on this computer.',
};

export function dockerInstalledLine(version: string): string {
  return `Docker is installed, version ${version}.`;
}

export function dockerRunningLine(engineVersion: string): string {
  return `Docker is running, Engine version ${engineVersion}.`;
}

export function composeReadyLine(version: string): string {
  return `Docker Compose is ready, version ${version}.`;
}

export function memoryReadyLine(sizeText: string): string {
  return `Docker has ${sizeText} of memory to work with, which is enough.`;
}

export const ALL_READY_LINE = 'Docker is ready for Aman on this computer.';

export const NOT_INSTALLED: Problem = {
  happened: 'Aman is not installed on this computer yet.',
  fix: 'Install Aman on this computer, then run aman status again.',
};

export const STATE_UNREADABLE: Problem = {
  happened: 'The record of what is installed could not be read.',
  fix: 'Run the installer again from the folder Aman was installed from, then run aman status again.',
};

// The wait is the lock's dead limit: an install stopped without cleaning up
// leaves its lock until its beats have been missing that long.
export const STATE_BUSY: Problem = {
  happened: 'Another install is running right now.',
  fix: `Wait for it to finish, or wait ${String(LOCK_TIMING.deadSeconds / 60)} minutes if you stopped an install a moment ago, then run aman status again.`,
};

// The doctor's own words for the same unreadable record: the next step
// names the doctor, not another command.
export const DOCTOR_STATE_UNREADABLE: Problem = {
  happened: 'The record of what is installed could not be read.',
  fix: 'Run the installer again from the folder Aman was installed from, then run aman doctor again.',
};

// What the entry point says when a command stops with a failure no
// command planned for: one plain problem instead of silence.
export const UNEXPECTED_FAILURE: Problem = {
  happened: 'Something went wrong that Aman did not expect, so it stopped.',
  fix: 'Run aman doctor and keep what it prints; it helps find what went wrong.',
};

export const DOCKER_NOT_ANSWERING: Record<SystemKind, Problem> = {
  darwin: {
    happened: 'Docker is not answering, so whether each instance is running is unknown.',
    fix: 'Open Docker Desktop from Launchpad, then run aman status again.',
  },
  linux: {
    happened: 'Docker is not answering, so whether each instance is running is unknown.',
    fix: 'Start Docker Engine on this computer, then run aman status again.',
  },
};

// The name and the address come from files in the state home, so a control
// character in them must not reach the screen as a terminal command.
function printable(text: string): string {
  return text.replace(/\p{Cc}/gu, '');
}

export function statusInstalledLine(version: string): string {
  return `Aman is installed, version ${printable(version)}.`;
}

export type InstanceState = 'running' | 'partly running' | 'stopped' | 'unknown';

export function statusInstanceLine(name: string, state: InstanceState, address: string | null): string {
  if (state === 'unknown') {
    return `Instance ${printable(name)}: whether it is running is unknown.`;
  }
  if (address === null) {
    return `Instance ${printable(name)} is ${state}.`;
  }
  return `Instance ${printable(name)} is ${state} at ${printable(address)}.`;
}

export const NO_INSTANCES_LINE = 'No instance has been made yet.';

// ---- the setup wizard ----------------------------------------------------------------------------
// The words of the wizard's page and of the setup command itself. The words
// of the checks, the plan and the steps are the installer's own and reach
// the page as data, so they are not repeated here.

export function setupUrlLine(url: string): string {
  return `Setup page: ${printable(url)}`;
}

export function setupDownloadsTotalLine(sizeMb: number): string {
  return `Downloads together: about ${String(sizeMb)} MB.`;
}

export const SETUP_OPENING_LINE = 'Opening the setup page in your browser.';

export const SETUP_BROWSER_PROBLEM: Problem = {
  happened: 'The setup page could not be opened in your browser by itself.',
  fix: 'Copy the setup page address above into your browser to open it.',
};

// What the password still lacks, in the installer's own words (its
// password_problem in installer/lib/common.sh says the same). A password
// is judged by the bytes it takes, because the sign-in check ignores
// everything past 72 of them.
export const PASSWORD_TOO_LONG_LINE =
  'The password can have at most 72 characters. Accented or non-Latin letters count as more than one.';
export const PASSWORD_LACK_LENGTH = 'at least 8 characters';
export const PASSWORD_LACK_NUMBER = 'a number';
export const PASSWORD_LACK_SYMBOL = 'a symbol, like @ # $ %';
export const PASSWORDS_DIFFER_LINE = 'The passwords do not match. Type them again.';
export const PASSWORD_MISSING_LINE = 'Type a password first. The password rules are listed under the field.';

// The wizard's screens, in order. Labels and short lines the page shows;
// the sentences among them follow the same plain-words rules as every
// other message.
export const SETUP_TEXT = {
  welcomeTitle: 'Set up Aman on this computer',
  welcomeWhat:
    'Aman is your private assistant. It runs on this computer only, and your information stays on this computer.',
  welcomeTime: 'Setup takes about 15 minutes and downloads a few GB, because Aman is built on this computer.',
  start: 'Start',
  checksTitle: 'Check this computer',
  checksIntro: 'Aman checks that this computer is ready. Nothing is changed by these checks.',
  checksBlocked: 'Something above needs fixing before setup can go on. Setup cannot start while a problem stands.',
  checkAgain: 'Check again',
  installDocker: 'Install Docker for me',
  continue: 'Continue',
  aboutTitle: 'About you',
  emailLabel: 'Your email, the one you sign in with',
  nameLabel: 'What should Aman call you?',
  passwordLabel: 'Choose a password',
  passwordAgainLabel: 'Type the password again',
  passwordRuleLength: 'At least 8 characters',
  passwordRuleNumber: 'A number',
  passwordRuleSymbol: 'A symbol, like @ # $ % ! -',
  passwordRuleBytes: 'At most 72 bytes',
  optionsTitle: 'Your choices',
  backupsLabel: 'Back up every day',
  backupsNote: 'Aman keeps the last few backups on this computer, so a mistake can be undone.',
  reachLabel: 'Who can reach Aman',
  reachLocal: 'This computer only',
  reachNetwork: 'This computer, and my phone on my home network',
  advanced: 'Advanced: email, calendar and Token Factory',
  emailProviderLabel: 'Email provider',
  emailAddressLabel: 'Email address',
  emailPasswordLabel: 'Email app password',
  emailImapHostLabel: 'Incoming mail server',
  emailImapPortLabel: 'Incoming mail server number',
  emailSmtpHostLabel: 'Outgoing mail server',
  emailSmtpPortLabel: 'Outgoing mail server number',
  calendarProviderLabel: 'Calendar provider',
  calendarEmailLabel: 'Calendar email address',
  calendarUrlLabel: 'Calendar address',
  calendarUserLabel: 'Calendar user name',
  calendarPasswordLabel: 'Calendar app password',
  tokenFactoryKeyLabel: 'Token Factory key',
  tokenFactoryModelLabel: 'Token Factory model',
  tokenFactoryCapLabel: 'Token Factory daily limit',
  reviewTitle: 'Review the plan',
  reviewIntro: 'This is what setup will do. Nothing on this computer changes until you choose Install.',
  reviewDownloads: 'Downloads',
  stateDone: 'Done',
  stateTodo: 'To do',
  stateAdmin: 'Needs admin',
  checkPass: 'Pass',
  checkWarn: 'Needs a look',
  checkBlock: 'Needs fixing',
  dockerChosen: 'Docker will be installed as part of setup.',
  elapsedLabel: 'Time so far',
  install: 'Install',
  back: 'Back',
  installingTitle: 'Setting up Aman',
  installingNote: 'This can take several minutes. You can close this page and come back; the setup keeps running.',
  adminNote: 'A step needs your permission. Your computer is about to ask for your password.',
  showDetails: 'Show details',
  hideDetails: 'Hide details',
  failedTitle: 'Setup stopped',
  failedWhat: 'The step below did not finish. Its record is under Show details.',
  tryAgain: 'Try again',
  copyLog: 'Copy the log',
  copied: 'Copied',
  dockerStoppedWhat: 'Docker stopped answering, so the setup cannot go on.',
  dockerStoppedNext: 'Start Docker, then choose Try again.',
  startDocker: 'Start Docker',
  retryPasswordLabel: 'Your password, typed again so the setup can go on',
  retryEmailPasswordLabel: 'Email app password, typed again so the setup can go on',
  retryCalendarPasswordLabel: 'Calendar app password, typed again so the setup can go on',
  retryTokenFactoryKeyLabel: 'Token Factory key, typed again so the setup can go on',
  retryAdminIntro: 'Trying again also runs these steps, which change this computer:',
  doneTitle: 'Aman is ready',
  openAman: 'Open Aman',
  phoneNote: 'On your phone, open this address or point the camera at the code:',
  backupsOnLine: 'Backups are on, and they are kept in the backups folder of Aman on this computer.',
  backupsOffLine: 'Backups are off. You can turn them on later with aman doctor.',
  gettingStarted: 'The page that opens has a short guide to your first steps with Aman.',
  doneWarningTitle: 'Aman is running, but a check found a problem',
  doneWarningNote: 'The finding and its fix are in the details below. You can also run aman doctor to see them again.',
  alreadyTitle: 'Aman is already set up',
  alreadyNote: 'Opening setup changes nothing on this computer. Your Aman is at this address:',
  lockedTitle: 'An install is already running',
  lockedNote:
    'Another install is running on this computer right now. Wait for it to finish, then open setup again.',
  attachNote: 'An install from this setup is still running. Its progress is below.',
  close: 'Close',
  closedLine: 'Setup is closed. You can close this tab now.',
  working: 'Working on it. This takes a few seconds.',
} as const;

export type SetupText = typeof SETUP_TEXT;
export function allMessageLines(): string[] {
  const lines: string[] = [versionLine('0.0.0'), ...HELP_LINES];
  const kinds: SystemKind[] = ['darwin', 'linux'];
  for (const kind of kinds) {
    lines.push(problemText(DOCKER_NOT_INSTALLED[kind]));
    lines.push(problemText(DOCKER_NOT_RUNNING[kind]));
    lines.push(problemText(COMPOSE_MISSING[kind]));
    lines.push(problemText(LOW_MEMORY[kind]));
    lines.push(problemText(MEMORY_NOT_REPORTED[kind]));
    lines.push(problemText(DOCKER_NOT_ANSWERING[kind]));
  }
  lines.push(problemText(ENGINE_VERSION_MISSING));
  lines.push(problemText(ENGINE_TOO_OLD.darwin));
  lines.push(problemText(ENGINE_TOO_OLD.linux));
  lines.push(problemText(unknownCommandProblem('example')));
  lines.push(problemText(UNKNOWN_DOCTOR_CHECK));
  lines.push(dockerInstalledLine('0.0.0'));
  lines.push(dockerRunningLine('0.0.0'));
  lines.push(composeReadyLine('0.0.0'));
  lines.push(memoryReadyLine('0 GB'));
  lines.push(ALL_READY_LINE);
  lines.push(problemText(NOT_INSTALLED));
  lines.push(problemText(STATE_UNREADABLE));
  lines.push(problemText(STATE_BUSY));
  lines.push(problemText(DOCTOR_STATE_UNREADABLE));
  lines.push(problemText(UNEXPECTED_FAILURE));
  lines.push(statusInstalledLine('aman-app:0'));
  lines.push(statusInstanceLine('main', 'running', 'http://127.0.0.1:8791'));
  lines.push(statusInstanceLine('main', 'partly running', 'http://127.0.0.1:8791'));
  lines.push(statusInstanceLine('main', 'stopped', null));
  lines.push(statusInstanceLine('main', 'unknown', null));
  lines.push(NO_INSTANCES_LINE);
  lines.push(setupUrlLine('http://127.0.0.1:8791'));
  lines.push(setupDownloadsTotalLine(2775));
  lines.push(SETUP_OPENING_LINE);
  lines.push(problemText(SETUP_BROWSER_PROBLEM));
  lines.push(PASSWORD_TOO_LONG_LINE);
  lines.push(PASSWORD_LACK_LENGTH);
  lines.push(PASSWORD_LACK_NUMBER);
  lines.push(PASSWORD_LACK_SYMBOL);
  lines.push(PASSWORDS_DIFFER_LINE);
  lines.push(PASSWORD_MISSING_LINE);
  lines.push(...Object.values(SETUP_TEXT));
  return lines;
}
