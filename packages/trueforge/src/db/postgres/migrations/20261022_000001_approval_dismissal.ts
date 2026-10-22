import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Cards whose approval request ended and were cleared. A cleared card can never run, so this table
 * only hides it from the pending list, and reloads keep it hidden. The session foreign key cascades.
 * Mirrors db/sqlite/migrations/20261022_000001_approval_dismissal.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('approval_dismissal')
      .addColumn('session_id', 'text', col => col.notNull().references('session.session_id').onDelete('cascade'))
      .addColumn('thread_id', 'text', col => col.notNull())
      .addColumn('tool_call_id', 'text', col => col.notNull())
      .addColumn('dismissed_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('approval_dismissal_pkey', ['session_id', 'thread_id', 'tool_call_id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('approval_dismissal').execute();
  });
}
