import { sql, type Kysely } from 'kysely';

/**
 * Sentinel per-user settings: Tier 2 "always ask" toggles and offline mode.
 * One row per (tenant_id, created_by). The UI reads/writes via
 * GET/PATCH /api/v1/user/settings/sentinel.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE sentinel_user_settings (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        tier2_always_ask TEXT NOT NULL DEFAULT '[]',
        offline_mode INTEGER NOT NULL DEFAULT 0 CHECK (offline_mode IN (0, 1)),
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
