import { sql, type Kysely } from 'kysely';

/**
 * Sentinel permission audit log: append-only record of tiered tool-call
 * decisions. Entries are written before the action executes. The UI reads
 * them via GET /api/v1/sessions/{id}/audit-log.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE sentinel_audit (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
        tool_name TEXT NOT NULL,
        description TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('logged', 'ran', 'stopped_by_user', 'undone', 'approved', 'denied', 'auto_denied')),
        auto_deny_reason TEXT,
        created_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX sentinel_audit_session_idx
      ON sentinel_audit (tenant_id, created_by, conversation_id, created_at DESC)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE sentinel_audit`.execute(trx);
  });
}
