import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * What the assistant notices for a person: their Reach me settings, the events the watchers have already raised
 * (one row per stable event id, so nothing is raised twice), and when each watcher last looked. `kind`, `status` and
 * the levels are plain text with no check, so a later kind needs no migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('reach_settings')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('settings', 'text', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('reach_settings_pk', ['tenant_id', 'created_by'])
      .execute();
    await trx.schema
      .createTable('noticing_event')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('event_id', 'text', col => col.notNull())
      .addColumn('kind', 'text', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('event_json', 'text', col => col.notNull())
      .addColumn('due_at', 'timestamptz')
      .addColumn('model_level', 'text')
      .addColumn('decided_level', 'text')
      .addColumn('delivered_level', 'text')
      .addColumn('reason', 'text')
      .addColumn('delivery_id', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('decided_at', 'timestamptz')
      .execute();
    await trx.schema
      .createIndex('noticing_event_owner_event_uq')
      .unique()
      .on('noticing_event')
      .columns(['tenant_id', 'created_by', 'event_id'])
      .execute();
    await trx.schema
      .createIndex('noticing_event_owner_decided_idx')
      .on('noticing_event')
      .columns(['tenant_id', 'created_by', 'decided_at'])
      .execute();
    await trx.schema
      .createIndex('noticing_event_tracking_idx')
      .on('noticing_event')
      .columns(['tenant_id', 'created_by', 'status', 'due_at'])
      .execute();
    await trx.schema
      .createTable('noticing_checkpoint')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('watcher', 'text', col => col.notNull())
      .addColumn('checked_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('noticing_checkpoint_pk', ['tenant_id', 'created_by', 'watcher'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('noticing_checkpoint').execute();
    await trx.schema.dropTable('noticing_event').execute();
    await trx.schema.dropTable('reach_settings').execute();
  });
}
