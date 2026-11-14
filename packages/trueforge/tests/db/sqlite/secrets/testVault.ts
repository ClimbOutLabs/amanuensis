import { promises as fs } from 'node:fs';

import type { Kysely } from 'kysely';

import { SqliteGlobalSettingsStore } from '../../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import type { Database } from '../../../../src/db/sqlite/types';
import { createMasterKey, recordKeyCheck } from '../../../../src/secrets/keyCheck';
import { SecretVault } from '../../../../src/secrets/secretVault';
import { TestKeyProvider } from '../../secretVaultContractSuite';

/** A vault set up for this database and unlocked with a fresh key. */
export async function createUnlockedVault(db: Kysely<Database>): Promise<SecretVault> {
  const settings = new SqliteGlobalSettingsStore(db);
  const key = createMasterKey();
  await recordKeyCheck({ settings, key });
  const vault = new SecretVault({ provider: new TestKeyProvider(key), settings });
  await vault.refresh();
  return vault;
}

/** A vault for this database whose key the host never delivered. */
export async function createLockedVault(db: Kysely<Database>): Promise<SecretVault> {
  const vault = new SecretVault({ provider: new TestKeyProvider(), settings: new SqliteGlobalSettingsStore(db) });
  await vault.refresh();
  return vault;
}

/** Whether `needle` appears anywhere in the database file or its sidecars. */
export async function databaseFilesContain({
  databaseFile,
  needle,
}: {
  databaseFile: string;
  needle: string;
}): Promise<boolean> {
  for (const suffix of ['', '-wal', '-shm']) {
    const bytes = await fs.readFile(`${databaseFile}${suffix}`).catch(() => Buffer.alloc(0));
    if (bytes.includes(needle)) {
      return true;
    }
  }
  return false;
}
