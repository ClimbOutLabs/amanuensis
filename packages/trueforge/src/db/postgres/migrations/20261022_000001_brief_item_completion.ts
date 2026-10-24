import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Morning brief items a person marked done. Owner-scoped; a re-mark refreshes completed_at through the
 * unique (tenant_id, created_by, item_key) key. Written by POST /api/v1/user/brief-items/completions.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('brief_item_completion')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('item_key', 'text', col => col.notNull())
      .addColumn('section', 'text', col => col.notNull())
      .addColumn('title', 'text', col => col.notNull())
      .addColumn('completed_at', 'timestamptz', col => col.notNull())
      .addCheckConstraint(
        'brief_item_completion_section_check',
        sql`section IN ('check_first', 'decision', 'coming_up', 'deadline')`,
      )
      .execute();
    await trx.schema
      .createIndex('brief_item_completion_owner_key_uq')
      .unique()
      .on('brief_item_completion')
      .columns(['tenant_id', 'created_by', 'item_key'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('brief_item_completion').execute();
  });
}
