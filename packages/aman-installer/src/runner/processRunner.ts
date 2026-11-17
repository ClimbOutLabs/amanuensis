import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  started: boolean;
}

export interface ProcessBytesResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
  started: boolean;
}

// Everything the installer runs on the computer goes through a runner, so a
// test can record or answer every command line instead of running it.
export interface ProcessRunner {
  run: (command: string, args: readonly string[]) => Promise<ProcessResult>;
  // For commands whose input or output is not text (the state volume is read
  // and written as a tar stream): bytes in on stdin, bytes out on stdout.
  // When onLine is given, every line the command prints (output and
  // errors) is handed to it as it arrives, so a long run can be shown
  // while it works. The result still carries the whole output.
  runBytes: (
    command: string,
    args: readonly string[],
    stdin: Uint8Array,
    onLine?: (line: string) => void,
  ) => Promise<ProcessBytesResult>;
}

// Cuts a stream of chunks into whole lines. A letter whose bytes are
// split across two chunks is still one letter, and a last line with
// no line break is handed over when the stream ends.
export function lineSplitter(onLine: (line: string) => void): { push: (chunk: Uint8Array) => void; end: () => void } {
  const decoder = new TextDecoder();
  let rest = '';
  const flush = (text: string): void => {
    const parts = (rest + text).split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) {
      onLine(part.endsWith('\r') ? part.slice(0, -1) : part);
    }
  };
  return {
    push: chunk => {
      flush(decoder.decode(chunk, { stream: true }));
    },
    end: () => {
      flush(decoder.decode());
      if (rest !== '') {
        onLine(rest);
        rest = '';
      }
    },
  };
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

  runBytes(
    command: string,
    args: readonly string[],
    stdin: Uint8Array,
    onLine?: (line: string) => void,
  ): Promise<ProcessBytesResult> {
    return new Promise(resolve => {
      const child = spawn(command, [...args], { shell: false });
      const chunks: Buffer[] = [];
      let stderr = '';
      const outLines = onLine === undefined ? null : lineSplitter(onLine);
      const errLines = onLine === undefined ? null : lineSplitter(onLine);
      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        outLines?.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        errLines?.push(chunk);
      });
      child.on('error', () => {
        resolve({ exitCode: 1, stdout: Buffer.concat(chunks), stderr, started: false });
      });
      child.on('close', code => {
        outLines?.end();
        errLines?.end();
        resolve({ exitCode: code ?? 1, stdout: Buffer.concat(chunks), stderr, started: true });
      });
      child.stdin.on('error', () => {
        // The program ended before reading its input; the close event
        // still reports how it ended.
      });
      // A view of the caller's bytes, not a copy: a caller that wipes
      // a secret after the run leaves no second copy behind here.
      child.stdin.end(Buffer.from(stdin.buffer, stdin.byteOffset, stdin.byteLength));
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

  async runBytes(
    command: string,
    args: readonly string[],
    stdin: Uint8Array,
    onLine?: (line: string) => void,
  ): Promise<ProcessBytesResult> {
    this.recorded.push(commandLine(command, args));
    return this.inner.runBytes(command, args, stdin, onLine);
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
  private readonly byteAnswers: ReadonlyMap<string, ProcessBytesResult>;

  constructor(
    answers: ReadonlyMap<string, ProcessResult>,
    byteAnswers: ReadonlyMap<string, ProcessBytesResult> = new Map(),
  ) {
    this.answers = answers;
    this.byteAnswers = byteAnswers;
  }

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    const answer = this.answers.get(commandLine(command, args));
    if (answer === undefined) {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', started: false });
    }
    return Promise.resolve(answer);
  }

  runBytes(command: string, args: readonly string[]): Promise<ProcessBytesResult> {
    const answer = this.byteAnswers.get(commandLine(command, args));
    if (answer === undefined) {
      return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false });
    }
    return Promise.resolve(answer);
  }
}

export function okResult(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: '', started: true };
}

export function okBytesResult(stdout: Uint8Array): ProcessBytesResult {
  return { exitCode: 0, stdout, stderr: '', started: true };
}
