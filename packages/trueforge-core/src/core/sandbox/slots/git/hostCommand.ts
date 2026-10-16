import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface HostCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

/** Kernel limits for one host program, so a hostile repository cannot take the server's memory, CPU or disk. */
export interface HostCommandLimits {
  addressSpaceBytes: number;
  cpuSeconds: number;
  /** The largest file the program may write. */
  fileBytes: number;
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
    /** Applied with prlimit; absent means no limits. */
    limits?: HostCommandLimits | undefined;
  }): Promise<HostCommandResult>;
}

const MAX_STDERR_CHARS = 8_000;
const PRLIMIT_BINARY = '/usr/bin/prlimit';

/** The program wrapped in prlimit. Refuses to run unlimited when limits were asked for and prlimit is missing. */
function limited(input: { argv: readonly string[]; limits: HostCommandLimits | undefined }): string[] {
  if (input.limits === undefined) {
    return [...input.argv];
  }
  if (!existsSync(PRLIMIT_BINARY)) {
    throw new Error('prlimit is not installed, so host git cannot be run with resource limits');
  }
  const { addressSpaceBytes, cpuSeconds, fileBytes } = input.limits;
  return [
    PRLIMIT_BINARY,
    `--as=${String(addressSpaceBytes)}`,
    `--cpu=${String(cpuSeconds)}`,
    `--fsize=${String(fileBytes)}`,
    '--core=0',
    '--',
    ...input.argv,
  ];
}

export const execFileRunner: HostCommandRunner = {
  run: input =>
    new Promise<HostCommandResult>((resolve, reject) => {
      let wrapped: string[];
      try {
        wrapped = limited({ argv: input.argv, limits: input.limits });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const [file, ...args] = wrapped;
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
