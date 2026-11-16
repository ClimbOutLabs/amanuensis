import { sql, type Kysely } from 'kysely';

/**
 * Paired terminal keys for the terminal app. Only the hash of each key is stored,
 * with the device name the person saw at pairing, when it was paired and last used,
 * and when it was revoked. Written when a pairing is confirmed in the web app; read
 * on every request a terminal key signs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE terminal_key (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_display_name TEXT NOT NULL,
        device_name TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE UNIQUE INDEX terminal_key_hash_idx
      ON terminal_key (key_hash)
    `.execute(trx);
    await sql`
      CREATE INDEX terminal_key_owner_idx
      ON terminal_key (tenant_id, subject_id)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE terminal_key`.execute(trx);
  });
}
