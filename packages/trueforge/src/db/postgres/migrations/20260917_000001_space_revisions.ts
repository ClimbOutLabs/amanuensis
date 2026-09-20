import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Revision history for spaces: bounded snapshots of superseded revisions, so a bad update can
 * be read back and restored. The store keeps the most recent `SPACE_REVISION_HISTORY_LIMIT`
 * snapshots per space and prunes older ones on each write.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('space_revision')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('space_id', 'text', col => col.notNull())
      .addColumn('revision', 'integer', col => col.notNull())
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('purpose', 'text', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('body', 'text', col => col.notNull().defaultTo(''))
      .addColumn('format', 'text', col => col.notNull().defaultTo('markdown'))
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('space_revision_pkey', ['tenant_id', 'created_by', 'space_id', 'revision'])
      .addCheckConstraint('space_revision_revision_check', sql`revision >= 1`)
      .addCheckConstraint('space_revision_status_check', sql`status IN ('active', 'archived')`)
      .addCheckConstraint('space_revision_format_check', sql`format IN ('markdown', 'html')`)
      .execute();
    await trx.schema
      .createIndex('space_revision_lookup_idx')
      .on('space_revision')
      .columns(['tenant_id', 'created_by', 'space_id', 'revision'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('space_revision').execute();
  });
}
