import { sql, type Kysely } from 'kysely';

/**
 * Facts a person pulled out of one chat's recall, stored with the chat so the list survives a
 * restart. Written by POST /api/v1/sessions/{session_id}/recall-exclusions; read by the recall
 * path each turn. The memory itself is never changed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE recall_exclusion (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        fact_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX recall_exclusion_session_idx
      ON recall_exclusion (tenant_id, session_id)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE recall_exclusion`.execute(trx);
  });
}
