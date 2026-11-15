import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

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
    settings: new PostgresGlobalSettingsStore(db),
    keyFile,
    ready: () => Promise.resolve(true),
    prepare: () => migrateToLatest(db),
    rekey: () => Promise.resolve(),
    close: () => db.destroy(),
  };
}
