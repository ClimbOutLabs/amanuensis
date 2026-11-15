import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * What the assistant notices for a person: their Reach me settings, the events the watchers found (one row per stable
 * event id, so nothing is raised twice, claimed by one pass at a time until delivered), where each watcher reads from
 * next (and how its passes are doing: since when they have failed and why, and the one message a pass keeps failing on),
 * and the per-person lease that keeps two passes from deciding how loudly to reach someone at once. `kind` and
 * `status` are plain text with no check, so a later kind needs no migration.
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
      .addColumn('verdict_json', 'text')
      .addColumn('delivery_id', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('claim_id', 'text')
      .addColumn('claimed_at', 'timestamptz')
      .addColumn('attempts', 'integer', col => col.notNull().defaultTo(0))
      .execute();
    await trx.schema
      .createIndex('noticing_event_owner_event_uq')
      .unique()
      .on('noticing_event')
      .columns(['tenant_id', 'created_by', 'event_id'])
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
      .addColumn('failing_since', 'timestamptz')
      .addColumn('failure_kind', 'text')
      .addColumn('stuck_message_id', 'text')
      .addColumn('stuck_passes', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('stuck_since', 'timestamptz')
      .addColumn('imap_cursor', 'text')
      .addColumn('source', 'text')
      .addPrimaryKeyConstraint('noticing_checkpoint_pk', ['tenant_id', 'created_by', 'watcher'])
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
    await trx.schema.dropTable('noticing_checkpoint').execute();
    await trx.schema.dropTable('noticing_event').execute();
    await trx.schema.dropTable('reach_settings').execute();
  });
}
