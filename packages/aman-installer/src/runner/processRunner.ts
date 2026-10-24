import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  started: boolean;
}

// Everything the installer runs on the computer goes through a runner, so a
// test can record or answer every command line instead of running it.
export interface ProcessRunner {
  run: (command: string, args: readonly string[]) => Promise<ProcessResult>;
}

export function commandLine(command: string, args: readonly string[]): string {
  const parts = [command];
  for (const arg of args) {
    if (/[\s"]/.test(arg)) {
      parts.push(`"${arg.replaceAll('"', '\\"')}"`);
    } else {
      parts.push(arg);
    }
  }
  return parts.join(' ');
}

export class SystemProcessRunner implements ProcessRunner {
  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    return new Promise(resolve => {
      const child = spawn(command, [...args], { shell: false });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', () => {
        resolve({ exitCode: 1, stdout, stderr, started: false });
      });
      child.on('close', code => {
        resolve({ exitCode: code ?? 1, stdout, stderr, started: true });
      });
    });
  }
}

// Wraps another runner and writes down every command line, in order. Tests
// compare those lines to a golden file, so a reviewer can read exactly what
// a flow would run on a person's computer.
export class RecordingProcessRunner implements ProcessRunner {
  private readonly inner: ProcessRunner;
  private readonly recorded: string[] = [];

  constructor(inner: ProcessRunner) {
    this.inner = inner;
  }

  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.recorded.push(commandLine(command, args));
    return this.inner.run(command, args);
  }

  lines(): readonly string[] {
    return this.recorded;
  }

  goldenText(): string {
    return `${this.recorded.join('\n')}\n`;
  }
}

// Answers from a fixed table of command lines, for tests. A command line
// that is not in the table fails, like a program that is not there.
export class StubProcessRunner implements ProcessRunner {
  private readonly answers: ReadonlyMap<string, ProcessResult>;

  constructor(answers: ReadonlyMap<string, ProcessResult>) {
    this.answers = answers;
  }

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    const answer = this.answers.get(commandLine(command, args));
    if (answer === undefined) {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', started: false });
    }
    return Promise.resolve(answer);
  }
}

export function okResult(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: '', started: true };
}
