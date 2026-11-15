import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { errorCode } from './errorCode';

export interface SecretsDatabase {
  /** Where this database's key records are kept. */
  settings: IGlobalSettingsStore;
  keyFile: string;
  /** Whether the database is already stored the way `prepare` leaves it. */
  ready(masterKey: Buffer): Promise<boolean>;
  /** Brings the database to the latest schema and, for SQLite, encrypts its file with this master key. */
  prepare(masterKey: Buffer): Promise<void>;
  /** Moves a SQLite file from one master key to another. Postgres has nothing to move. */
  rekey(keys: { from: Buffer; to: Buffer }): Promise<void>;
  close(): Promise<void>;
}

/** What Postgres answers when a table does not exist. */
const UNDEFINED_TABLE = '42P01';

/**
 * A new Postgres database has no tables until `prepare` runs, and setup looks for key records before that.
 * No table means no records, so the look answers that nothing is stored instead of failing.
 */
export function settingsBeforeSchema(settings: IGlobalSettingsStore): IGlobalSettingsStore {
  return {
    getSetting: async input => {
      try {
        return await settings.getSetting(input);
      } catch (error) {
        if (errorCode(error) === UNDEFINED_TABLE) {
          return undefined;
        }
        throw error;
      }
    },
    setSetting: input => settings.setSetting(input),
    deleteSetting: input => settings.deleteSetting(input),
    compareAndSetSetting: input => settings.compareAndSetSetting(input),
  };
}

/**
 * The database and key file this instance is configured to use. Loaded lazily
 * by the command, so naming a database file on the command line never loads the server config.
 */
export async function openConfiguredSecretsDatabase(): Promise<SecretsDatabase> {
  const { default: configuration } = await import('../config');
  const keyFile = configuration.SECRETS_KEY_FILE;
  if (configuration.STANDALONE) {
    const { sqliteSecretsDatabase } = await import('./secretsSqlite');
    return sqliteSecretsDatabase({ sqlitePath: configuration.SQLITE_PATH, keyFile });
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
  return {
    settings: settingsBeforeSchema(new PostgresGlobalSettingsStore(db)),
    keyFile,
    ready: () => Promise.resolve(true),
    prepare: () => migrateToLatest(db),
    rekey: () => Promise.resolve(),
    close: () => db.destroy(),
  };
}
