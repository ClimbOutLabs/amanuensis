import { sql, type Kysely } from 'kysely';

/**
 * The one person who signs in with a password Aman keeps itself (local sign-in). The store keeps this
 * to a single row. `session_version` goes up whenever the password changes or is reset, so every
 * session issued before that stops working.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE local_user (
        id TEXT NOT NULL PRIMARY KEY,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        session_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE local_user`.execute(trx);
  });
}
