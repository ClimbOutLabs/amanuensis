import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The delivery feed and the devices that turned push notices on. `kind`, `level` and `channel` are plain text, with no
 * check, so a later kind or channel needs no migration. Deliveries and attempts are owner-scoped.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('delivery')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('kind', 'text', col => col.notNull())
      .addColumn('level', 'text', col => col.notNull())
      .addColumn('text', 'text', col => col.notNull())
      .addColumn('reason', 'text', col => col.notNull())
      .addColumn('link', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('seen_at', 'timestamptz')
      .execute();
    await trx.schema
      .createIndex('delivery_owner_created_idx')
      .on('delivery')
      .columns(['tenant_id', 'created_by', 'created_at', 'id'])
      .execute();
    await trx.schema
      .createTable('delivery_attempt')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('delivery_id', 'text', col => col.notNull().references('delivery.id').onDelete('cascade'))
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('channel', 'text', col => col.notNull())
      .addColumn('outcome', 'text', col => col.notNull())
      .addColumn('detail', 'text')
      .addColumn('target', 'text')
      .addColumn('attempted_at', 'timestamptz', col => col.notNull())
      .execute();
    await trx.schema
      .createIndex('delivery_attempt_delivery_idx')
      .on('delivery_attempt')
      .column('delivery_id')
      .execute();
    await trx.schema
      .createTable('push_subscription')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('endpoint', 'text', col => col.notNull())
      .addColumn('p256dh', 'text', col => col.notNull())
      .addColumn('auth', 'text', col => col.notNull())
      .addColumn('label', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .execute();
    await trx.schema
      .createIndex('push_subscription_endpoint_uq')
      .unique()
      .on('push_subscription')
      .column('endpoint')
      .execute();
    await trx.schema
      .createIndex('push_subscription_owner_idx')
      .on('push_subscription')
      .columns(['tenant_id', 'created_by'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('push_subscription').execute();
    await trx.schema.dropTable('delivery_attempt').execute();
    await trx.schema.dropTable('delivery').execute();
  });
}
