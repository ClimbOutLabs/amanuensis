import { sql, type Kysely } from 'kysely';

/**
 * Cards whose approval request ended and were cleared. A cleared card can never run, so this table
 * only hides it from the pending list, and reloads keep it hidden. The session foreign key cascades.
 * Mirrors db/postgres/migrations/20261022_000001_approval_dismissal.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE approval_dismissal (
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        dismissed_at TEXT NOT NULL,
        PRIMARY KEY (session_id, thread_id, tool_call_id)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE approval_dismissal`.execute(trx);
  });
}
