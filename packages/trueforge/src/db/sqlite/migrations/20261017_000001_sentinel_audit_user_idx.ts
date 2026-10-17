import { sql, type Kysely } from 'kysely';

/**
 * Serves the per-user audit listing across every chat, newest first. Mirrors
 * db/postgres/migrations/20261017_000001_sentinel_audit_user_idx.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE INDEX sentinel_audit_user_idx
      ON sentinel_audit (tenant_id, created_by, created_at DESC, id DESC)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP INDEX sentinel_audit_user_idx`.execute(trx);
  });
}
