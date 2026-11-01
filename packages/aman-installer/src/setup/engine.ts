import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseEvents, type InstallerEvent } from './events.ts';

// How the wizard drives the installer. The engine stays the shell
// installer: this module only starts it, with the events descriptor the
// PR that added --events defined (descriptor 3, opened by the caller),
// the person's secrets on its stdin, and its terminal output kept in a
// log the wizard can show under "Show details". Nothing about an install
// step lives here.

export interface DryRunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  events: InstallerEvent[];
}

export interface EngineRunner {
  // A read-only run: the preflight alone (no answers yet) or the plan
  // (with the answers). Changes nothing on disk.
  dryRun: (args: readonly string[], eventsFile: string) => Promise<DryRunOutcome>;
  // The real run, started apart from the wizard so it keeps going when
  // the wizard or the browser closes. Resolves with the child's pid as
  // soon as it is started. The stdin lines are written and the input is
  // closed before this resolves; nothing of them is kept here.
  startInstall: (options: {
    args: readonly string[];
    stdinLines: readonly string[];
    eventsFile: string;
    logFile: string;
  }) => Promise<{ pid: number }>;
  // `install.sh docker`: install or start Docker, for the failure
  // screen's Start Docker button. Its output goes to the log file.
  startDocker: (options: { logFile: string }) => Promise<{ pid: number }>;
  // The terminal QR text for a short link, from the installer's own
  // qr.mjs; null when it cannot be made.
  qrText: (text: string) => Promise<string | null>;
}

export class EngineStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineStartError';
  }
}

const STDOUT_CAP = 8 * 1024 * 1024;

export class SystemEngineRunner implements EngineRunner {
  private readonly installerDir: string;

  constructor(options: { installerDir: string }) {
    this.installerDir = options.installerDir;
  }

  private installSh(): string {
    return join(this.installerDir, 'install.sh');
  }

  async dryRun(args: readonly string[], eventsFile: string): Promise<DryRunOutcome> {
    const eventsFd = openSync(eventsFile, 'w');
    try {
      const { exitCode, stdout, stderr } = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(this.installSh(), [...args], {
            stdio: ['ignore', 'pipe', 'pipe', eventsFd],
            shell: false,
          });
          let out = '';
          let err = '';
          child.stdout?.on('data', (chunk: Buffer) => {
            if (out.length < STDOUT_CAP) {
              out += chunk.toString('utf8');
            }
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            // Kept only so a run that stops early can say why, in the
            // installer's own words; the wizard's record of a run is
            // its event stream, not this text.
            if (err.length < STDOUT_CAP) {
              err += chunk.toString('utf8');
            }
          });
          child.on('error', error => {
            reject(new EngineStartError('the installer could not be started', { cause: error }));
          });
          child.on('close', code => {
            resolve({ exitCode: code ?? 1, stdout: out, stderr: err });
          });
        },
      );
      const eventsText = await readFile(eventsFile, 'utf8').catch(() => '');
      return { exitCode, stdout, stderr, events: parseEvents(eventsText) };
    } finally {
      closeSync(eventsFd);
    }
  }

  startInstall(options: {
    args: readonly string[];
    stdinLines: readonly string[];
    eventsFile: string;
    logFile: string;
  }): Promise<{ pid: number }> {
    return new Promise((resolve, reject) => {
      const logFd = openSync(options.logFile, 'a');
      const eventsFd = openSync(options.eventsFile, 'w');
      const child = spawn(this.installSh(), [...options.args], {
        stdio: ['pipe', logFd, logFd, eventsFd],
        detached: true,
        shell: false,
      });
      const onError = (error: Error) => {
        closeSync(logFd);
        closeSync(eventsFd);
        reject(new EngineStartError('the installer could not be started', { cause: error }));
      };
      child.on('error', onError);
      child.on('spawn', () => {
        child.removeListener('error', onError);
        child.on('error', () => {
          // Started, then stopped: the run's own record says how it went.
        });
        const pid = child.pid;
        if (pid === undefined) {
          closeSync(logFd);
          closeSync(eventsFd);
          reject(new EngineStartError('the installer could not be started'));
          return;
        }
        const stdin = child.stdin;
        if (stdin === null) {
          closeSync(logFd);
          closeSync(eventsFd);
          reject(new EngineStartError('the installer could not be started'));
          return;
        }
        stdin.on('error', () => {
          // The installer ended before reading its input; the run's
          // record still says how it went.
        });
        for (const line of options.stdinLines) {
          stdin.write(`${line}\n`);
        }
        stdin.end();
        child.unref();
        closeSync(logFd);
        closeSync(eventsFd);
        resolve({ pid });
      });
    });
  }

  startDocker(options: { logFile: string }): Promise<{ pid: number }> {
    return new Promise((resolve, reject) => {
      const logFd = openSync(options.logFile, 'a');
      const child = spawn(this.installSh(), ['docker'], {
        stdio: ['ignore', logFd, logFd],
        detached: true,
        shell: false,
      });
      const onError = (error: Error) => {
        closeSync(logFd);
        reject(new EngineStartError('the installer could not be started', { cause: error }));
      };
      child.on('error', onError);
      child.on('spawn', () => {
        child.removeListener('error', onError);
        child.on('error', () => undefined);
        const pid = child.pid;
        closeSync(logFd);
        if (pid === undefined) {
          reject(new EngineStartError('the installer could not be started'));
          return;
        }
        child.unref();
        resolve({ pid });
      });
    });
  }

  qrText(text: string): Promise<string | null> {
    return new Promise(resolve => {
      const child = spawn('node', [join(this.installerDir, 'lib', 'qr.mjs'), text], { shell: false });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', () => {
        resolve(null);
      });
      child.on('close', code => {
        resolve(code === 0 && out.trim() !== '' ? out.replace(/\n$/, '') : null);
      });
    });
  }
}

// Reads a run's events file as it stands; a file still being written
// parses line by line, and a half-written last line is simply not an
// event yet.
export function readEventsFile(eventsFile: string): InstallerEvent[] {
  try {
    return parseEvents(readFileSync(eventsFile, 'utf8'));
  } catch {
    return [];
  }
}
