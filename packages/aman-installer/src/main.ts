import { homedir, hostname, networkInterfaces } from 'node:os';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { runCli } from './cli.ts';
import { resolvePendingSwap } from './commands/upgrade.ts';
import { installerConfig } from './config.ts';
import { hostForPlatform } from './host/hostFor.ts';
import { systemWindowsJobs, windowsPaths } from './host/windowsJobs.ts';
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
// anywhere else a plain line is read, as the visible question reads.
async function askSecretLine(question: string): Promise<string | null> {
  const input = process.stdin;
  if (!input.isTTY) {
    return askLine(question);
  }
  process.stdout.write(`${question} `);
  return new Promise<string | null>(resolve => {
    // One entry per character typed, so a backspace takes back
    // exactly one character, never half of one.
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
      for (const ch of chunk.toString('utf8')) {
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
}).then(
  exitCode => {
    process.exitCode = exitCode;
  },
  () => {
    process.exitCode = 1;
  },
);
