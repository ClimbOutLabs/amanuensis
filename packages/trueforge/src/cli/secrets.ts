import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { FileKeyProvider, encodeKeyFile } from '../secrets/fileKeyProvider';
import { checkMasterKey, createMasterKey, recordKeyCheck } from '../secrets/keyCheck';
import {
  RECOVERY_COPY_SETTING,
  RecoveryCopyMissingError,
  RecoveryKeyFormatError,
  RecoveryKeyRejectedError,
  generateRecoveryKey,
  recoverMasterKey,
  saveRecoveryCopy,
} from '../secrets/recoveryKey';
import { adoptDatabase } from '../secrets/retiredKeys';
import type { Command } from './command';
import { processEnv, type CliEnv } from './env';
import { errorCode } from './errorCode';
import { UsageError, type CliIo } from './io';
import type { SecretsDatabase } from './secretsRuntime';
import { sqliteSecretsDatabase } from './secretsSqlite';

const USAGE = `Usage: aman secrets <init|first-run|check-recovery|adopt|key> [--sqlite <file>] [--key-file <file>] [--if-needed]

  init            Set up saved secrets for this database and print its recovery key as {"recovery_key": "..."}.
                  Uses the key file if it is there, and makes one only if it is not.
                  Makes the database too when Aman has not started yet.
  first-run       The same setup for a person at a terminal: shows the recovery key in plain words,
                  and says nothing when setup is already done.
  check-recovery  Read a recovery key on stdin and print {"ok": true} if it unlocks this database.
  adopt           Read a recovery key on stdin and tie a database that came from another computer to this
                  computer's key. Prints {"adopted": true}, or {"already_adopted": true} when it was done before.
                  The same recovery key keeps working afterwards.
  key             Make this computer's key file if it is not there, and print {"created": true or false}.
                  It touches no database.

--if-needed makes init print {"already_set_up": true} and change nothing when setup is already done.
--sqlite defaults to SQLITE_PATH, --key-file to SECRETS_KEY_FILE. With neither --sqlite nor SQLITE_PATH,
or with STANDALONE=false, the database and key file come from this instance's settings.
`;

function requiredKeyFile(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new UsageError(`Missing --key-file (or SECRETS_KEY_FILE in the environment).\n\n${USAGE}`);
  }
  return path.resolve(value);
}

/** Reads the key file, or makes it when it is not there. A new file is never written over an existing one. */
async function loadOrCreateKey(keyFile: string): Promise<{ key: Buffer; created: boolean }> {
  const loaded = await new FileKeyProvider(keyFile).load();
  if (loaded.status === 'loaded') {
    return { key: loaded.key, created: false };
  }
  if (existsSync(keyFile)) {
    throw new Error(`${loaded.reason}: ${keyFile}. Fix or remove that file, then run this again.`);
  }
  const key = createMasterKey();
  await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  try {
    await writeFile(keyFile, encodeKeyFile(key), { flag: 'wx', mode: 0o600 });
  } catch (caught) {
    if (errorCode(caught) === 'EEXIST') {
      throw new Error('Another setup made the key file at the same time. Run this again.', { cause: caught });
    }
    throw caught;
  }
  return { key, created: true };
}

/** Sets the database up and returns its new recovery key, or nothing when it already had one. */
async function initSecrets(database: SecretsDatabase): Promise<string | undefined> {
  const { settings, keyFile } = database;
  const { key, created } = await loadOrCreateKey(keyFile);
  try {
    const state = await checkMasterKey({ settings, key });
    if (state === 'wrong_key') {
      throw new Error(
        'This database was set up with a different key. Unlock it with its recovery key instead of running setup.',
      );
    }
    // The file is encrypted before the records say so, so a database marked as set up is never readable.
    await database.prepare(key);
    if (state === 'match' && (await settings.getSetting({ key: RECOVERY_COPY_SETTING })) !== undefined) {
      return undefined;
    }
    if (state === 'not_set_up') {
      await recordKeyCheck({ settings, key });
    }
    // Also finishes a setup that stopped after the key check value was saved but before the recovery key.
    const recoveryKey = generateRecoveryKey();
    await saveRecoveryCopy({ settings, masterKey: key, recoveryKey });
    return recoveryKey;
  } catch (caught) {
    // A key made by this run unlocks nothing if setup did not finish, so it is not left behind.
    if (created && (await checkMasterKey({ settings, key })) !== 'match') {
      await rm(keyFile, { force: true });
    }
    throw caught;
  }
}

async function checkRecovery({ settings, io }: { settings: IGlobalSettingsStore; io: CliIo }) {
  try {
    await recoverMasterKey({ settings, recoveryKey: await io.readStdin() });
  } catch (caught) {
    if (caught instanceof RecoveryKeyFormatError || caught instanceof RecoveryKeyRejectedError) {
      throw new UsageError(WRONG_RECOVERY_KEY, { cause: caught });
    }
    if (caught instanceof RecoveryCopyMissingError) {
      throw new Error('This database has no recovery key yet. Run "aman secrets init" first.', { cause: caught });
    }
    throw caught;
  }
}

const WRONG_RECOVERY_KEY = 'That recovery key does not unlock this database. Check each group of digits and try again.';

async function adopt({
  database,
  io,
}: {
  database: SecretsDatabase;
  io: CliIo;
}): Promise<'adopted' | 'already_adopted'> {
  const { settings, keyFile } = database;
  const recoveryKey = await io.readStdin();
  const { key, created } = await loadOrCreateKey(keyFile);
  try {
    return await adoptDatabase({
      settings,
      masterKey: key,
      recoveryKey,
      moveDatabase: earlierKey => database.rekey({ from: earlierKey, to: key }),
    });
  } catch (caught) {
    if (created) {
      await rm(keyFile, { force: true });
    }
    if (caught instanceof RecoveryKeyFormatError || caught instanceof RecoveryKeyRejectedError) {
      throw new UsageError(WRONG_RECOVERY_KEY, { cause: caught });
    }
    if (caught instanceof RecoveryCopyMissingError) {
      throw new Error(
        'This database has no recovery key, so it cannot be moved to this computer. Restore it on the computer it came from.',
        { cause: caught },
      );
    }
    throw caught;
  }
}

export async function runSecrets({
  args,
  io,
  env,
}: {
  args: readonly string[];
  io: CliIo;
  env: CliEnv;
}): Promise<number> {
  const [action, ...rest] = args;
  if (
    action !== 'init' &&
    action !== 'first-run' &&
    action !== 'check-recovery' &&
    action !== 'adopt' &&
    action !== 'key'
  ) {
    throw new UsageError(USAGE);
  }
  let values: { sqlite?: string; 'key-file'?: string; 'if-needed'?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { sqlite: { type: 'string' }, 'key-file': { type: 'string' }, 'if-needed': { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (caught) {
    throw new UsageError(`${caught instanceof Error ? caught.message : 'Bad arguments.'}\n\n${USAGE}`, {
      cause: caught,
    });
  }
  if (action === 'key') {
    const { created } = await loadOrCreateKey(requiredKeyFile(values['key-file'] ?? env['SECRETS_KEY_FILE']));
    await io.stdout(`${JSON.stringify({ created })}\n`);
    return 0;
  }
  const database = await openDatabase({
    action,
    sqlitePath: values.sqlite ?? (env['STANDALONE'] === 'false' ? undefined : env['SQLITE_PATH']),
    keyFile: values['key-file'] ?? env['SECRETS_KEY_FILE'],
  });
  try {
    if (action === 'check-recovery') {
      await checkRecovery({ settings: database.settings, io });
      await io.stdout(`${JSON.stringify({ ok: true })}\n`);
      return 0;
    }
    if (action === 'adopt') {
      const result = await adopt({ database, io });
      await io.stdout(`${JSON.stringify(result === 'adopted' ? { adopted: true } : { already_adopted: true })}\n`);
      return 0;
    }
    if (action === 'first-run') {
      const recoveryKey = (await alreadySetUp(database)) ? undefined : await initSecrets(database);
      if (recoveryKey !== undefined) {
        await io.stdout(firstRunNotice({ keyFile: database.keyFile, recoveryKey }));
      }
      return 0;
    }
    if (await alreadySetUp(database)) {
      if (values['if-needed'] !== true) {
        throw new Error('Saved secrets are already set up for this database. Nothing was changed.');
      }
      await io.stdout(`${JSON.stringify({ already_set_up: true })}\n`);
      return 0;
    }
    const recoveryKey = await initSecrets(database);
    if (recoveryKey === undefined) {
      // It had its key and recovery key already; only the file still had to be encrypted.
      await io.stdout(`${JSON.stringify({ already_set_up: true })}\n`);
      return 0;
    }
    await io.stdout(`${JSON.stringify({ recovery_key: recoveryKey })}\n`);
    await io.stderr('Saved secrets are set up. Write down the recovery key now: it is shown only this once.\n');
    return 0;
  } finally {
    await database.close();
  }
}

/** The named SQLite file, or the database this instance is configured to use when none is named. */
async function openDatabase({
  action,
  sqlitePath,
  keyFile,
}: {
  action: 'init' | 'first-run' | 'check-recovery' | 'adopt';
  sqlitePath: string | undefined;
  keyFile: string | undefined;
}): Promise<SecretsDatabase> {
  if (sqlitePath === undefined || sqlitePath.trim() === '') {
    const { openConfiguredSecretsDatabase } = await import('./secretsRuntime');
    const configured = await openConfiguredSecretsDatabase();
    return keyFile === undefined ? configured : { ...configured, keyFile: path.resolve(keyFile) };
  }
  const file = path.resolve(sqlitePath);
  if ((action === 'check-recovery' || action === 'adopt') && !existsSync(file)) {
    throw new Error(
      action === 'adopt'
        ? `No database at ${file}. Restore the backup first, then run this again.`
        : `No database at ${file}. Run "aman secrets init" first.`,
    );
  }
  // Only setup reads the key file, so a recovery check needs none.
  return sqliteSecretsDatabase({
    sqlitePath: file,
    keyFile: action === 'check-recovery' ? '' : requiredKeyFile(keyFile),
  });
}

function firstRunNotice({ keyFile, recoveryKey }: { keyFile: string; recoveryKey: string }): string {
  return `
Aman keeps your saved logins encrypted with a key stored on this computer:
  ${keyFile}

Your recovery key is:

  ${recoveryKey}

Write it down and keep it somewhere safe. It is shown only this once.
You need it to open your data if this computer's key is ever lost.

`;
}

async function alreadySetUp(database: SecretsDatabase): Promise<boolean> {
  const { settings, keyFile } = database;
  const loaded = await new FileKeyProvider(keyFile).load();
  return (
    loaded.status === 'loaded' &&
    (await checkMasterKey({ settings, key: loaded.key })) === 'match' &&
    (await settings.getSetting({ key: RECOVERY_COPY_SETTING })) !== undefined &&
    (await database.ready(loaded.key))
  );
}

export const secrets: Command = ({ args, io }) => runSecrets({ args, io, env: processEnv() });
