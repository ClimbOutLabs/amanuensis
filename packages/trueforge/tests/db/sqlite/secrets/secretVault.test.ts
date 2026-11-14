import { promises as fs } from 'node:fs';

import { sql } from 'kysely';

import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { createMasterKey, recordKeyCheck } from '../../../../src/secrets/keyCheck';
import type { SecretContext } from '../../../../src/secrets/secretCipher';
import { SecretVault } from '../../../../src/secrets/secretVault';
import { TestKeyProvider, runSecretVaultContractSuite } from '../../secretVaultContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

const context: SecretContext = { table: 'global_settings', primary_key: 'vacuum_secret', field: 'value' };

describe('SecretVault on SQLite', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runSecretVaultContractSuite(() => new SqliteGlobalSettingsStore(env.db));

  it('still decrypts after VACUUM and after copying the database file', async () => {
    const settings = new SqliteGlobalSettingsStore(env.db);
    const key = createMasterKey();
    await recordKeyCheck({ settings, key });
    const vault = new SecretVault({ provider: new TestKeyProvider(key), settings });
    await vault.refresh();
    // Churn rows first so VACUUM has pages to move.
    for (let i = 0; i < 50; i += 1) {
      await settings.setSetting({ key: `filler_${i}`, value: 'x'.repeat(2000) });
    }
    await settings.setSetting({ key: 'vacuum_secret', value: vault.encrypt({ plaintext: 'vacuum-canary', context }) });
    for (let i = 0; i < 50; i += 1) {
      await settings.deleteSetting({ key: `filler_${i}` });
    }
    await sql`VACUUM`.execute(env.db);
    const afterVacuum = await settings.getSetting({ key: 'vacuum_secret' });
    expect(vault.decrypt({ value: afterVacuum?.value ?? '', context })).toBe('vacuum-canary');

    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(env.db);
    const copyFile = `${env.databaseFile}.copy`;
    await fs.copyFile(env.databaseFile, copyFile);
    const copyDb = createSqliteDb(copyFile);
    try {
      await migrateSqliteToLatest(copyDb);
      const copySettings = new SqliteGlobalSettingsStore(copyDb);
      const restored = new SecretVault({ provider: new TestKeyProvider(key), settings: copySettings });
      expect(await restored.refresh()).toEqual({ status: 'unlocked' });
      const copied = await copySettings.getSetting({ key: 'vacuum_secret' });
      expect(restored.decrypt({ value: copied?.value ?? '', context })).toBe('vacuum-canary');
    } finally {
      await copyDb.destroy();
    }
  });
});
