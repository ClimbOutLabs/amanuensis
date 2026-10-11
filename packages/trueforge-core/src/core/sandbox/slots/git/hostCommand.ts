import { execFile } from 'node:child_process';

export interface HostCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs one program on the server's own machine. Implementations never use a shell. */
export interface HostCommandRunner {
  run(input: {
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
    cwd: string | undefined;
    timeoutMs: number;
    signal: AbortSignal | undefined;
    maxStdoutBytes: number;
  }): Promise<HostCommandResult>;
}

const MAX_STDERR_CHARS = 8_000;

export const execFileRunner: HostCommandRunner = {
  run: input =>
    new Promise<HostCommandResult>((resolve, reject) => {
      const [file, ...args] = input.argv;
      if (file === undefined) {
        reject(new Error('empty command'));
        return;
      }
      execFile(
        file,
        args,
        {
          env: { ...input.env },
          cwd: input.cwd,
          timeout: input.timeoutMs,
          maxBuffer: input.maxStdoutBytes,
          encoding: 'buffer',
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        (error, stdout, stderr) => {
          const text = stderr.toString('utf8').slice(-MAX_STDERR_CHARS);
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr: text });
            return;
          }
          if (typeof error.code === 'number') {
            resolve({ exitCode: error.code, stdout, stderr: text });
            return;
          }
          if (input.signal?.aborted === true) {
            reject(new Error('the call was cancelled', { cause: error }));
            return;
          }
          // Spawn failures, timeouts and output overflow are not a git verdict.
          resolve({ exitCode: -1, stdout, stderr: `${text}\n${error.message}`.trim() });
        },
      );
    }),
};
