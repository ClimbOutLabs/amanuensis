import { openCommandVault, openReadingVault } from './cliVault';
import { deriveDatabaseKey } from './databaseKey';
import { FileKeyProvider } from './fileKeyProvider';
import { KEY_CHECK_SETTING, checkMasterKey } from './keyCheck';
import type { KeyLoadResult } from './keyProvider';
import { KeyRecordFile, keyRecordPath } from './keyRecordFile';
import { recoverMasterKey } from './recoveryKey';
import type { SecretVault } from './secretVault';

/**
 * The vault of a SQLite instance for a one-off command, and the key of its database file.
 * `command` needs the instance set up and this computer's key present. `reading` also accepts an
 * instance from before encryption, whose file needs no key.
 */
export async function openSqliteVault({
  sqlitePath,
  keyFile,
  mode,
}: {
  sqlitePath: string;
  keyFile: string;
  mode: 'command' | 'reading';
}): Promise<{ vault: SecretVault; databaseKey: Buffer | undefined }> {
  const settings = new KeyRecordFile(keyRecordPath(sqlitePath));
  if (mode === 'command') {
    const vault = await openCommandVault({ settings, keyFile });
    return { vault, databaseKey: vault.databaseKey() };
  }
  const vault = await openReadingVault({ settings, keyFile });
  return { vault, databaseKey: vault.state.status === 'unlocked' ? vault.databaseKey() : undefined };
}

/** The key of a SQLite database that came from another computer, from its key records and its recovery key. */
export async function sqliteDatabaseKeyFromRecovery({
  sqlitePath,
  recoveryKey,
}: {
  sqlitePath: string;
  recoveryKey: string;
}): Promise<Buffer> {
  const settings = new KeyRecordFile(keyRecordPath(sqlitePath));
  return deriveDatabaseKey(await recoverMasterKey({ settings, recoveryKey }));
}

/** The database file is encrypted and this computer cannot open it; `why` says so without the next step. */
export class DatabaseLockedError extends Error {
  readonly why: string;

  constructor(why: string) {
    super(`${why}. Run "aman doctor" to see how to fix it.`);
    this.name = 'DatabaseLockedError';
    this.why = why;
  }
}

/**
 * The key of a SQLite instance's database file, or nothing for an instance from before encryption.
 * Throws with the one thing to do next when the file is encrypted and this computer cannot open it.
 */
export async function sqliteDatabaseKey({
  sqlitePath,
  keyFile,
}: {
  sqlitePath: string;
  keyFile: string | undefined;
}): Promise<Buffer | undefined> {
  const settings = new KeyRecordFile(keyRecordPath(sqlitePath));
  if ((await settings.getSetting({ key: KEY_CHECK_SETTING })) === undefined) {
    return undefined;
  }
  const loaded: KeyLoadResult =
    keyFile === undefined || keyFile.trim() === ''
      ? { status: 'unavailable', reason: 'no key file is named' }
      : await new FileKeyProvider(keyFile).load();
  if (loaded.status !== 'loaded') {
    throw new DatabaseLockedError(`This computer's key is not available (${loaded.reason})`);
  }
  if ((await checkMasterKey({ settings, key: loaded.key })) !== 'match') {
    throw new DatabaseLockedError("This computer's key does not match this instance's data");
  }
  return deriveDatabaseKey(loaded.key);
}
