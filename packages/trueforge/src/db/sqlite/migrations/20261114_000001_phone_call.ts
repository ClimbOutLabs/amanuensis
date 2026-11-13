import { sql, type Kysely } from 'kysely';

/**
 * The phone calls Aman placed: Twilio's id for each, where it stands, how it ended, the chat it was written in, and
 * the one-time media token kept only as a hash while it waits to be used. Status, outcome and mode are plain text so
 * a later value needs no migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE phone_call (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        call_sid TEXT,
        status TEXT NOT NULL,
        outcome TEXT,
        mode TEXT,
        session_id TEXT,
        fallback TEXT NOT NULL,
        token_hash TEXT,
        token_expires_at TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ended_at TEXT
      ) STRICT
    `.execute(trx);
    await sql`CREATE UNIQUE INDEX phone_call_call_sid_idx ON phone_call (call_sid)`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE phone_call`.execute(trx);
  });
}
