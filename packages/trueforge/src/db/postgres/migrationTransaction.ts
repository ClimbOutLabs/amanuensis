import type { Kysely } from 'kysely';

/**
 * Keeps migrations atomic both when invoked directly and through Kysely's
 * Postgres migrator, which already supplies a transaction to each migration.
 */
export function withMigrationTransaction(
  db: Kysely<unknown>,
  callback: (trx: Kysely<unknown>) => Promise<void>,
): Promise<void> {
  return db.isTransaction ? callback(db) : db.transaction().execute(callback);
}
