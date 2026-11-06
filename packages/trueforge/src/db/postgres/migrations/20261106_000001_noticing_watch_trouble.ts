import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * A watcher's trouble kept with its checkpoint: since when passes have failed and why, and the one message a pass
 * keeps failing on. Mirrors db/sqlite/migrations/20261106_000001_noticing_watch_trouble.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('noticing_checkpoint')
      .addColumn('failing_since', 'timestamptz')
      .addColumn('failure_kind', 'text')
      .addColumn('stuck_message_id', 'text')
      .addColumn('stuck_passes', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('stuck_since', 'timestamptz')
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('noticing_checkpoint')
      .dropColumn('stuck_since')
      .dropColumn('stuck_passes')
      .dropColumn('stuck_message_id')
      .dropColumn('failure_kind')
      .dropColumn('failing_since')
      .execute();
  });
}
