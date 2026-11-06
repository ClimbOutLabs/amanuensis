import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Lets a noticed event wait as `pending` until a pass claims and delivers it, so a failed or interrupted delivery is
 * tried again, and adds the per-person lease that keeps two passes from deciding how loudly to reach someone at once.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('noticing_event')
      .addColumn('claim_id', 'text')
      .addColumn('claimed_at', 'timestamptz')
      .addColumn('attempts', 'integer', col => col.notNull().defaultTo(0))
      .execute();
    await trx.schema
      .createTable('reach_lease')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('holder', 'text', col => col.notNull())
      .addColumn('held_until', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('reach_lease_pk', ['tenant_id', 'created_by'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('reach_lease').execute();
    await trx.schema
      .alterTable('noticing_event')
      .dropColumn('attempts')
      .dropColumn('claimed_at')
      .dropColumn('claim_id')
      .execute();
  });
}
