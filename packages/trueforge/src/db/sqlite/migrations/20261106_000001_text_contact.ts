import { sql, type Kysely } from 'kysely';

/**
 * The number a person gets texts on, and where confirming it stands: when it was proved, when it was opted out, and
 * the pending one-time code kept only as a salted hash, with its expiry, attempts and how many were sent this hour.
 * `mode` is plain text so a later choice of words needs no migration.
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
        code_hash TEXT,
        code_salt TEXT,
        code_expires_at TEXT,
        code_attempts INTEGER NOT NULL,
        send_window_started_at TEXT,
        sends_in_window INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX text_contact_phone_idx ON text_contact (phone)`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE text_contact`.execute(trx);
  });
}
