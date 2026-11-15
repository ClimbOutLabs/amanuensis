import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

import { FileKeyProvider } from '../secrets/fileKeyProvider';
import { checkMasterKey } from '../secrets/keyCheck';
import { KeyRecordFile, keyRecordPath } from '../secrets/keyRecordFile';
import {
  RECOVERY_COPY_SETTING,
  RecoveryKeyFormatError,
  RecoveryKeyRejectedError,
  openRecoveryCopy,
} from '../secrets/recoveryKey';
import { SealedFileError, openSealedStream, sealStream, type SealedHeader } from '../secrets/sealedStream';
import { SecretKeyMismatchError } from '../secrets/secretCipher';
import type { Command } from './command';
import { processEnv, type CliEnv } from './env';
import { UsageError } from './io';

const USAGE = `Usage:
  aman seal   --in <file|-> --out <file|-> [--sqlite <file> | --this-computer-only] [--key-file <file>]
  aman unseal --in <file|-> --out <file|-> [--key-file <file> | --recovery-key-file <file>]

seal    Encrypt a file so only this computer's key or the recovery key can open it.
        With --this-computer-only no recovery key can open it: for data from before a recovery key existed.
unseal  Open a sealed file. On another computer, pass a file holding the recovery key.

"-" reads from stdin or writes to stdout. --sqlite defaults to SQLITE_PATH, --key-file to SECRETS_KEY_FILE.
When unseal writes to stdout and fails, throw away what it wrote.
`;

export interface SealDeps {
  env: CliEnv;
  stdin: () => NodeJS.ReadableStream;
  stdout: () => NodeJS.WritableStream;
}

interface SealOptions {
  in: string;
  out: string;
  sqlite: string | undefined;
  keyFile: string | undefined;
  recoveryKeyFile: string | undefined;
  thisComputerOnly: boolean;
}

function parseOptions({ args, env }: { args: readonly string[]; env: CliEnv }): SealOptions {
  let values: {
    in?: string;
    out?: string;
    sqlite?: string;
    'key-file'?: string;
    'recovery-key-file'?: string;
    'this-computer-only'?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        in: { type: 'string' },
        out: { type: 'string' },
        sqlite: { type: 'string' },
        'key-file': { type: 'string' },
        'recovery-key-file': { type: 'string' },
        'this-computer-only': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (caught) {
    throw new UsageError(`${caught instanceof Error ? caught.message : 'Bad arguments.'}\n\n${USAGE}`, {
      cause: caught,
    });
  }
  if (values.in === undefined || values.out === undefined) {
    throw new UsageError(`Missing --in or --out.\n\n${USAGE}`);
  }
  const optional = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : path.resolve(value);
  return {
    in: values.in,
    out: values.out,
    sqlite: optional(values.sqlite ?? env['SQLITE_PATH']),
    keyFile: optional(values['key-file'] ?? env['SECRETS_KEY_FILE']),
    recoveryKeyFile: optional(values['recovery-key-file']),
    thisComputerOnly: values['this-computer-only'] === true,
  };
}

async function* buffers(stream: NodeJS.ReadableStream): AsyncGenerator<Buffer> {
  for await (const chunk of stream) {
    yield typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
  }
}

async function loadMachineKey(keyFile: string | undefined): Promise<Buffer> {
  if (keyFile === undefined) {
    throw new UsageError(`Missing --key-file (or SECRETS_KEY_FILE in the environment).\n\n${USAGE}`);
  }
  const loaded = await new FileKeyProvider(keyFile).load();
  if (loaded.status !== 'loaded') {
    throw new Error(`This computer's key is not available: ${loaded.reason}. Run "aman doctor" to see why.`);
  }
  return loaded.key;
}

/** The recovery copy of the database the sealed data comes from, after checking the key is that database's key. */
async function loadRecoveryCopy({ sqlite, key }: { sqlite: string | undefined; key: Buffer }): Promise<string> {
  if (sqlite === undefined) {
    throw new UsageError(`Missing --sqlite (or SQLITE_PATH in the environment).\n\n${USAGE}`);
  }
  // Read from the key records beside the database, so the database itself is never opened here.
  const settings = new KeyRecordFile(keyRecordPath(sqlite));
  if ((await checkMasterKey({ settings, key })) !== 'match') {
    throw new Error('Saved secrets are not set up for this database with this key. Run "aman secrets init" first.');
  }
  const copy = await settings.getSetting({ key: RECOVERY_COPY_SETTING });
  if (copy === undefined) {
    throw new Error('This database has no recovery key yet. Run "aman secrets init" first.');
  }
  return copy.value;
}

/** Writes to a ".part" file that only takes the final name once everything was written, or to stdout. */
async function writeOutput({
  out,
  content,
  deps,
}: {
  out: string;
  content: AsyncIterable<Buffer>;
  deps: SealDeps;
}): Promise<void> {
  if (out === '-') {
    await pipeline(Readable.from(content), deps.stdout(), { end: false });
    return;
  }
  const target = path.resolve(out);
  const part = `${target}.part`;
  try {
    await pipeline(Readable.from(content), createWriteStream(part, { mode: 0o600, flags: 'wx' }));
    await rename(part, target);
  } catch (caught) {
    await rm(part, { force: true });
    throw caught;
  }
}

function openInput({ input, deps }: { input: string; deps: SealDeps }): AsyncIterable<Buffer> {
  return buffers(input === '-' ? deps.stdin() : createReadStream(path.resolve(input)));
}

async function runSeal({ options, deps }: { options: SealOptions; deps: SealDeps }): Promise<void> {
  const masterKey = await loadMachineKey(options.keyFile);
  const recoveryCopy = options.thisComputerOnly
    ? null
    : await loadRecoveryCopy({ sqlite: options.sqlite, key: masterKey });
  await writeOutput({
    out: options.out,
    content: sealStream({ source: openInput({ input: options.in, deps }), masterKey, recoveryCopy }),
    deps,
  });
}

async function runUnseal({ options, deps }: { options: SealOptions; deps: SealDeps }): Promise<void> {
  const recoveryKeyFile = options.recoveryKeyFile;
  const resolveMasterKey =
    recoveryKeyFile === undefined
      ? () => loadMachineKey(options.keyFile)
      : async (header: SealedHeader): Promise<Buffer> => {
          if (header.recovery_copy === null) {
            throw new Error(
              'This sealed file has no recovery copy. It can only be opened on the computer that made it.',
            );
          }
          return openRecoveryCopy({ copy: header.recovery_copy, recoveryKey: await readFile(recoveryKeyFile, 'utf8') });
        };
  try {
    await writeOutput({
      out: options.out,
      content: openSealedStream({ source: openInput({ input: options.in, deps }), resolveMasterKey }),
      deps,
    });
  } catch (caught) {
    if (caught instanceof RecoveryKeyFormatError || caught instanceof RecoveryKeyRejectedError) {
      throw new UsageError('That recovery key does not open this file. Check each group of digits and try again.', {
        cause: caught,
      });
    }
    if (caught instanceof SecretKeyMismatchError) {
      throw new Error(
        "This file was sealed with another computer's key. Open it with the recovery key of the Aman that made it.",
        { cause: caught },
      );
    }
    if (caught instanceof SealedFileError) {
      throw new Error(`${caught.message} Nothing was restored from it.`, { cause: caught });
    }
    throw caught;
  }
}

export function createSealCommand({ action, deps }: { action: 'seal' | 'unseal'; deps: SealDeps }): Command {
  return async ({ args }) => {
    const options = parseOptions({ args, env: deps.env });
    await (action === 'seal' ? runSeal({ options, deps }) : runUnseal({ options, deps }));
    return 0;
  };
}

const processDeps: SealDeps = { env: processEnv(), stdin: () => process.stdin, stdout: () => process.stdout };

export const seal: Command = createSealCommand({ action: 'seal', deps: processDeps });
export const unseal: Command = createSealCommand({ action: 'unseal', deps: processDeps });
