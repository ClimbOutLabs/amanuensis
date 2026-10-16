/** Process boundary for CLI commands; fakes replace it in tests. */
export interface CliIo {
  readStdin(): Promise<string>;
  stdout(text: string): Promise<void>;
  stderr(text: string): Promise<void>;
}

/** Bad arguments or input; the dispatcher maps it to exit code 2. */
export class UsageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UsageError';
  }
}

function writeAll(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  if (stream.isTTY) {
    throw new UsageError('Secrets are read from stdin only. Pipe the value in, for example: printf %s "$value" | ...');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const piece: unknown = chunk;
    if (Buffer.isBuffer(piece)) {
      chunks.push(piece);
    } else if (typeof piece === 'string') {
      chunks.push(Buffer.from(piece));
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function processIo(): CliIo {
  return {
    readStdin: () => readAll(process.stdin),
    stdout: text => writeAll(process.stdout, text),
    stderr: text => writeAll(process.stderr, text),
  };
}
