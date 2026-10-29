import { homedir, hostname, networkInterfaces } from 'node:os';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { runCli } from './cli.ts';
import { resolvePendingSwap } from './commands/upgrade.ts';
import { installerConfig } from './config.ts';
import { hostForPlatform } from './host/hostFor.ts';
import { systemWindowsJobs, windowsPaths } from './host/windowsJobs.ts';
import { UNEXPECTED_FAILURE, problemText } from './messages.ts';
import { fetchBytesFromNetwork } from './release/download.ts';
import { SystemProcessRunner } from './runner/processRunner.ts';
import { storeForHost } from './state/storeFor.ts';

// The one entry point the single executable is built from.
const host = hostForPlatform(process.platform);
const runner = new SystemProcessRunner();
const config = installerConfig({ env: process.env, homeDir: homedir() });

// The folder the adopt step put the installed program in, from the one
// place that names the Windows folders. Only a Windows computer has
// one; everywhere else the upgrade refuses before it would be used.
const programsDir = host.kind === 'windows' ? windowsPaths(config.localAppDataDir).programsDir : null;

// The upgrade's one question, asked on the terminal. Anything but an
// explicit yes is a no, and a closed terminal is a no.
async function askConfirm(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${question} Type yes to go ahead: `);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    terminal.close();
  }
}

// The install command's questions, asked on the terminal. A closed
// terminal is no answer.
async function askLine(question: string): Promise<string | null> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(`${question} `)).trim();
  } catch {
    return null;
  } finally {
    terminal.close();
  }
}

// The install command's secret questions: what is typed is not shown.
// On a real terminal the input is read a key at a time with echo off;
// anywhere else a plain line is read. Both paths follow the one rule
// for secrets, applied here and nowhere else: a secret is taken
// exactly as typed, never trimmed, because a password can begin or
// end with a space. (The visible questions above do trim; the install
// command trims the pasted key itself, at its question, where a paste
// can carry stray spaces with it.)
async function askSecretLine(question: string): Promise<string | null> {
  const input = process.stdin;
  if (!input.isTTY) {
    const terminal = createInterface({ input, output: process.stdout });
    try {
      return await terminal.question(`${question} `);
    } catch {
      return null;
    } finally {
      terminal.close();
    }
  }
  process.stdout.write(`${question} `);
  return new Promise<string | null>(resolve => {
    // One entry per character typed, so a backspace takes back
    // exactly one character, never half of one. The bytes are decoded
    // as a stream, so a letter whose bytes arrive in two chunks is
    // still the one letter, not two broken halves.
    const decoder = new TextDecoder();
    const chars: string[] = [];
    const wasRaw = input.isRaw;
    const cleanup = (): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of decoder.decode(chunk, { stream: true })) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(chars.join(''));
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(null);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          chars.pop();
        } else if (ch >= ' ') {
          chars.push(ch);
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.on('end', onEnd);
  });
}

// This same program is also built as Aman-Setup.exe (the setup build
// names its output, not its code). Run with no command under that
// name, it does what the computer in front of it needs: the first
// install where Aman is not installed, the adopt step on a starter
// PC, and the upgrade on an installed one. The setup command in the
// command list decides which, from what is on the computer.
function invokedAsSetup(): boolean {
  for (const path of [process.argv[1] ?? '', process.execPath]) {
    if (/^aman-setup(\.exe)?$/i.test(basename(path))) {
      return true;
    }
  }
  return false;
}

let args = process.argv.slice(2);
if (args.length === 0 && invokedAsSetup()) {
  args = ['setup'];
}
if (programsDir !== null) {
  resolvePendingSwap(programsDir);
}
runCli(args, {
  host,
  runner,
  store: storeForHost({ host, runner, stateHome: config.stateHome }),
  windowsJobs: systemWindowsJobs({
    runner,
    localAppDataDir: config.localAppDataDir,
    selfExePath: process.execPath,
  }),
  probeHealth: async (url: string) => {
    try {
      const response = await fetch(url);
      return response.status === 200;
    } catch {
      return false;
    }
  },
  sleep: (ms: number) =>
    new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    }),
  print: (line: string) => {
    console.log(line);
  },
  now: () => Math.floor(Date.now() / 1000),
  homeDir: config.homeDir,
  stateHome: host.kind === 'windows' ? null : config.stateHome,
  osReleasePath: config.osReleasePath,
  dockerConfigDir: config.dockerConfigDir,
  appService: config.appService,
  confirm: askConfirm,
  fetchBytes: fetchBytesFromNetwork,
  programsDir,
  arch: process.arch,
  interfaces: networkInterfaces(),
  hostName: hostname(),
  ask: askLine,
  askSecret: askSecretLine,
  interfaces: networkInterfaces(),
  hostName: hostname(),
}).then(
  exitCode => {
    process.exitCode = exitCode;
  },
  () => {
    // A failure no command planned for still owes the person one
    // plain problem and a next step, never a silent exit.
    console.log(problemText(UNEXPECTED_FAILURE));
    process.exitCode = 1;
  },
);
