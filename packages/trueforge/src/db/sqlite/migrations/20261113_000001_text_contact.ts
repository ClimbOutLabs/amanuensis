import { sql, type Kysely } from 'kysely';

/**
 * The number a person gets texts on, and where confirming it stands: when it was proved, when it was opted out, a new
 * number waiting for its code, and the pending one-time code kept only as a keyed hash with the id of the key, its expiry and attempts.
 * `mode` is plain text so a later choice of words needs no migration. Codes sent are counted in `text_send_count`, apart
 * from the number, so removing a number never resets a limit.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE text_contact (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        phone TEXT NOT NULL,
        mode TEXT NOT NULL,
        confirmed_at TEXT,
        opted_out_at TEXT,
        pending_phone TEXT,
        code_hash TEXT,
        code_salt TEXT,
        code_key_id TEXT,
        code_expires_at TEXT,
        code_attempts INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX text_contact_phone_idx ON text_contact (phone)`.execute(trx);
    await sql`CREATE INDEX text_contact_pending_phone_idx ON text_contact (pending_phone)`.execute(trx);
    await sql`
      CREATE TABLE text_send_count (
        scope_key TEXT NOT NULL PRIMARY KEY,
        window_started_at TEXT NOT NULL,
        sends INTEGER NOT NULL
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE text_send_count`.execute(trx);
    await sql`DROP TABLE text_contact`.execute(trx);
  });
}
