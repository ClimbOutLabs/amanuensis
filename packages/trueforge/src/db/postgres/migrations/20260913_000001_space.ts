import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/** Durable spaces: a persistent, named, structured page the model creates and updates. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('space_aggregate')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('revision', 'integer', col => col.notNull())
      .addPrimaryKeyConstraint('space_aggregate_pkey', ['tenant_id', 'created_by'])
      .addCheckConstraint('space_aggregate_revision_check', sql`revision >= 0`)
      .execute();
    await trx.schema
      .createTable('space')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('id', 'text', col => col.notNull())
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('purpose', 'text', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('body', 'text', col => col.notNull().defaultTo(''))
      .addColumn('revision', 'integer', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('space_pkey', ['tenant_id', 'created_by', 'id'])
      .addCheckConstraint('space_status_check', sql`status IN ('active', 'archived')`)
      .addCheckConstraint('space_revision_check', sql`revision >= 1`)
      .execute();
    await trx.schema
      .createIndex('space_list_idx')
      .on('space')
      .columns(['tenant_id', 'created_by', 'status', 'name', 'id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('space').execute();
    await trx.schema.dropTable('space_aggregate').execute();
  });
}
