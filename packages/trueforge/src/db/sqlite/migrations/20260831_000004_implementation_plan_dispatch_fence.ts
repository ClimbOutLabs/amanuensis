import { sql, type Kysely } from 'kysely';

/** Durable cross-replica plan dispatch boundary and checkout binding. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE implementation_plan_grant ADD COLUMN checkout_id TEXT`.execute(trx);
    await sql`ALTER TABLE implementation_plan_grant ADD COLUMN workspace_cwd TEXT`.execute(trx);
    await sql`ALTER TABLE implementation_plan_grant ADD COLUMN revoked_at TEXT`.execute(trx);
    // Grants minted before checkout identity existed are deliberately invalidated.
    await sql`
      UPDATE implementation_plan_grant
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE checkout_id IS NULL OR workspace_cwd IS NULL
    `.execute(trx);
    await sql`
      CREATE TABLE implementation_plan_dispatch (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        workspace_cwd TEXT NOT NULL,
        checkout_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('dispatching', 'completed')),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (session_id, turn_id, dispatch_id),
        FOREIGN KEY (session_id, grant_id)
          REFERENCES implementation_plan_grant(session_id, grant_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id, turn_id)
          REFERENCES turn(session_id, turn_id) ON DELETE CASCADE
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX implementation_plan_dispatch_pending_idx
        ON implementation_plan_dispatch (session_id, grant_id, state)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS implementation_plan_dispatch`.execute(trx);
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('revoked_at').execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('workspace_cwd').execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('checkout_id').execute();
  });
}
