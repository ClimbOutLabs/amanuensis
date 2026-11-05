import { sql, type Kysely } from 'kysely';

/**
 * Lets a noticed event wait as `pending` until a pass claims and delivers it, so a failed or interrupted delivery is
 * tried again, and adds the per-person lease that keeps two passes from deciding how loudly to reach someone at once.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE noticing_event ADD COLUMN claim_id TEXT`.execute(trx);
    await sql`ALTER TABLE noticing_event ADD COLUMN claimed_at TEXT`.execute(trx);
    await sql`ALTER TABLE noticing_event ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`.execute(trx);
    await sql`
      CREATE TABLE reach_lease (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        holder TEXT NOT NULL,
        held_until TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE reach_lease`.execute(trx);
    await sql`ALTER TABLE noticing_event DROP COLUMN attempts`.execute(trx);
    await sql`ALTER TABLE noticing_event DROP COLUMN claimed_at`.execute(trx);
    await sql`ALTER TABLE noticing_event DROP COLUMN claim_id`.execute(trx);
  });
}
