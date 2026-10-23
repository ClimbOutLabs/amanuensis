import { sql, type Kysely } from 'kysely';

/**
 * Morning brief items a person marked done. Owner-scoped; a re-mark refreshes completed_at through the
 * unique (tenant_id, created_by, item_key) key. Written by POST /api/v1/user/brief-items/completions.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE brief_item_completion (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        item_key TEXT NOT NULL,
        section TEXT NOT NULL CHECK (section IN ('check_first', 'decision', 'coming_up', 'deadline')),
        title TEXT NOT NULL,
        completed_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE UNIQUE INDEX brief_item_completion_owner_key_uq
      ON brief_item_completion (tenant_id, created_by, item_key)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE brief_item_completion`.execute(trx);
  });
}
