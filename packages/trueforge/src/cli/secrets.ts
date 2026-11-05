import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createSqliteDb } from '../db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
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
import type { Command } from './command';
import { processEnv, type CliEnv } from './env';
import { errorCode } from './errorCode';
import { UsageError, type CliIo } from './io';

const USAGE = `Usage: aman secrets <init|check-recovery> [--sqlite <file>] [--key-file <file>]

  init            Set up saved secrets for this database and print its recovery key as {"recovery_key": "..."}.
                  Uses the key file if it is there, and makes one only if it is not.
  check-recovery  Read a recovery key on stdin and print {"ok": true} if it unlocks this database.

--sqlite defaults to SQLITE_PATH, --key-file to SECRETS_KEY_FILE.
`;

function requiredValue({ value, flag, envKey }: { value: string | undefined; flag: string; envKey: string }): string {
  if (value === undefined || value.trim() === '') {
    throw new UsageError(`Missing ${flag} (or ${envKey} in the environment).\n\n${USAGE}`);
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

async function initSecrets({ settings, keyFile }: { settings: SqliteGlobalSettingsStore; keyFile: string }) {
  const { key, created } = await loadOrCreateKey(keyFile);
  const state = await checkMasterKey({ settings, key });
  if (state === 'wrong_key') {
    throw new Error(
      'This database was set up with a different key. Unlock it with its recovery key instead of running setup.',
    );
  }
  if (state === 'match' && (await settings.getSetting({ key: RECOVERY_COPY_SETTING })) !== undefined) {
    throw new Error('Saved secrets are already set up for this database. Nothing was changed.');
  }
  if (state === 'not_set_up') {
    try {
      await recordKeyCheck({ settings, key });
    } catch (caught) {
      if (created) {
        await rm(keyFile, { force: true });
      }
      throw caught;
    }
  }
  // Also finishes a setup that stopped after the key check value was saved but before the recovery key.
  const recoveryKey = generateRecoveryKey();
  await saveRecoveryCopy({ settings, masterKey: key, recoveryKey });
  return recoveryKey;
}

async function checkRecovery({ settings, io }: { settings: SqliteGlobalSettingsStore; io: CliIo }) {
  try {
    await recoverMasterKey({ settings, recoveryKey: await io.readStdin() });
  } catch (caught) {
    if (caught instanceof RecoveryKeyFormatError || caught instanceof RecoveryKeyRejectedError) {
      throw new UsageError(
        'That recovery key does not unlock this database. Check each group of digits and try again.',
        {
          cause: caught,
        },
      );
    }
    if (caught instanceof RecoveryCopyMissingError) {
      throw new Error('This database has no recovery key yet. Run "aman secrets init" first.', { cause: caught });
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
  if (action !== 'init' && action !== 'check-recovery') {
    throw new UsageError(USAGE);
  }
  let values: { sqlite?: string; 'key-file'?: string };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { sqlite: { type: 'string' }, 'key-file': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (caught) {
    throw new UsageError(`${caught instanceof Error ? caught.message : 'Bad arguments.'}\n\n${USAGE}`, {
      cause: caught,
    });
  }
  const sqlitePath = requiredValue({
    value: values.sqlite ?? env['SQLITE_PATH'],
    flag: '--sqlite',
    envKey: 'SQLITE_PATH',
  });
  if (!existsSync(sqlitePath)) {
    throw new Error(`No database at ${sqlitePath}. Start Aman once so it makes one, then run this again.`);
  }
  const db = createSqliteDb(sqlitePath);
  try {
    const settings = new SqliteGlobalSettingsStore(db);
    if (action === 'check-recovery') {
      await checkRecovery({ settings, io });
      await io.stdout(`${JSON.stringify({ ok: true })}\n`);
      return 0;
    }
    const keyFile = requiredValue({
      value: values['key-file'] ?? env['SECRETS_KEY_FILE'],
      flag: '--key-file',
      envKey: 'SECRETS_KEY_FILE',
    });
    const recoveryKey = await initSecrets({ settings, keyFile });
    await io.stdout(`${JSON.stringify({ recovery_key: recoveryKey })}\n`);
    await io.stderr('Saved secrets are set up. Write down the recovery key now: it is shown only this once.\n');
    return 0;
  } finally {
    await db.destroy();
  }
}

export const secrets: Command = ({ args, io }) => runSecrets({ args, io, env: processEnv() });
