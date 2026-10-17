import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Serves the per-user audit listing across every chat, newest first. Mirrors
 * db/sqlite/migrations/20261017_000001_sentinel_audit_user_idx.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`
      CREATE INDEX sentinel_audit_user_idx
      ON sentinel_audit (tenant_id, created_by, created_at DESC, id DESC)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropIndex('sentinel_audit_user_idx').execute();
  });
}
