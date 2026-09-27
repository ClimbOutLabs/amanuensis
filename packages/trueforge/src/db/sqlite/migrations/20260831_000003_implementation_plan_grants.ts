import { sql, type Kysely } from 'kysely';

/** Owner-scoped implementation-plan grant durability. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE implementation_plan_grant (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        grant_id TEXT NOT NULL,
        grant BLOB NOT NULL CHECK (json_valid(grant, 8) AND json_type(grant) = 'object'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, grant_id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX implementation_plan_grant_owner_idx
        ON implementation_plan_grant (tenant_id, created_by, session_id, grant_id)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS implementation_plan_grant`.execute(trx);
  });
}
