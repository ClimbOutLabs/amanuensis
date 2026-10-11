import { sql, type Kysely } from 'kysely';

/** Per-user Sentinel preferences: offline mode and the Tier 2 kinds the user relaxed. */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE sentinel_user_settings (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        offline_mode INTEGER NOT NULL CHECK (offline_mode IN (0, 1)),
        tier2_auto_allow BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE sentinel_user_settings`.execute(trx);
  });
}
