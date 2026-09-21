import { sql, type Kysely } from 'kysely';

/**
 * Repair the initial approval-grant migration, which declared a TEXT column
 * while the SQLite stores consistently bind JSON as JSONB BLOBs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await sql`
        CREATE TABLE session_new (
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          agent_id TEXT,
          agent_name TEXT,
          agent_spec BLOB,
          title TEXT,
          last_turn_id TEXT,
          approval_grants BLOB NOT NULL,
          custom BLOB,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_activity_timestamp_ms INTEGER NOT NULL,
          PRIMARY KEY (session_id),
          CHECK (
            (agent_id IS NOT NULL AND agent_spec IS NULL)
            OR (agent_id IS NULL AND agent_spec IS NOT NULL)
          )
        ) STRICT
      `.execute(trx);

      await sql`
        INSERT INTO session_new (
          tenant_id,
          session_id,
          created_by,
          agent_id,
          agent_name,
          agent_spec,
          title,
          last_turn_id,
          approval_grants,
          custom,
          created_at,
          updated_at,
          last_activity_timestamp_ms
        )
        SELECT
          tenant_id,
          session_id,
          created_by,
          agent_id,
          agent_name,
          agent_spec,
          title,
          last_turn_id,
          jsonb(approval_grants),
          custom,
          created_at,
          updated_at,
          last_activity_timestamp_ms
        FROM session
      `.execute(trx);

      await sql`DROP TABLE session`.execute(trx);
      await sql`ALTER TABLE session_new RENAME TO session`.execute(trx);

      await sql`
        CREATE INDEX session_list_idx
          ON session (tenant_id, created_at, session_id)
      `.execute(trx);
      await sql`
        CREATE INDEX session_list_updated_at_idx
          ON session (tenant_id, updated_at, session_id)
      `.execute(trx);
      await sql`
        CREATE INDEX session_agent_id_idx
          ON session (tenant_id, agent_id)
          WHERE agent_id IS NOT NULL
      `.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  return Promise.reject(new Error('20260824_000020_session_approval_grants_jsonb is not reversible'));
}
