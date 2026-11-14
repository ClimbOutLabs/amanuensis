import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

export interface SecretsDatabase {
  settings: IGlobalSettingsStore;
  keyFile: string;
  close(): Promise<void>;
}

/**
 * The database and key file this instance is configured to use, at the latest schema. Loaded lazily
 * by the command, so naming a database file on the command line never loads the server config.
 */
export async function openConfiguredSecretsDatabase(): Promise<SecretsDatabase> {
  const { default: configuration } = await import('../config');
  const keyFile = configuration.SECRETS_KEY_FILE;
  if (configuration.STANDALONE) {
    const [{ createSqliteDb }, { migrateSqliteToLatest }, { SqliteGlobalSettingsStore }] = await Promise.all([
      import('../db/sqlite/client'),
      import('../db/migrateSqlite'),
      import('../db/sqlite/global-settings-store/SqliteGlobalSettingsStore'),
    ]);
    await mkdir(path.dirname(configuration.SQLITE_PATH), { recursive: true, mode: 0o700 });
    const db = createSqliteDb(configuration.SQLITE_PATH);
    try {
      await migrateSqliteToLatest(db);
    } catch (error) {
      await db.destroy();
      throw error;
    }
    return { settings: new SqliteGlobalSettingsStore(db), keyFile, close: () => db.destroy() };
  }
  const [{ createDb }, { migrateToLatest }, { PostgresGlobalSettingsStore }] = await Promise.all([
    import('../db/postgres/client'),
    import('../db/migratePostgres'),
    import('../db/postgres/global-settings-store/PostgresGlobalSettingsStore'),
  ]);
  const db = createDb({
    connectionString: configuration.DATABASE_URL,
    poolMax: configuration.DATABASE_POOL_MAX,
    statementTimeoutMs: configuration.POSTGRES_STATEMENT_TIMEOUT_MS,
    idleInTransactionSessionTimeoutMs: configuration.POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
    connectionTimeoutMs: configuration.POSTGRES_CONNECT_TIMEOUT_MS,
    onIdleClientError: error => {
      console.error(`A Postgres connection broke while idle: ${error.message}`);
    },
  });
  try {
    await migrateToLatest(db);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return { settings: new PostgresGlobalSettingsStore(db), keyFile, close: () => db.destroy() };
}
