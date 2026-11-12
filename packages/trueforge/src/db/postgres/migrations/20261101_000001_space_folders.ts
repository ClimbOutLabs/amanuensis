import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Folders for spaces. Placement lives in its own table, beside the space row, so moving a space
 * never touches its revision, its history, or the owner's space revision.
 * Mirrors db/sqlite/migrations/20261101_000001_space_folders.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('space_folder')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('id', 'text', col => col.notNull())
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('space_folder_pkey', ['tenant_id', 'created_by', 'id'])
      .execute();
    await trx.schema
      .createIndex('space_folder_owner_name_idx')
      .on('space_folder')
      .columns(['tenant_id', 'created_by', 'name', 'id'])
      .execute();
    await trx.schema
      .createTable('space_folder_assignment')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('space_id', 'text', col => col.notNull())
      .addColumn('folder_id', 'text', col => col.notNull())
      .addPrimaryKeyConstraint('space_folder_assignment_pkey', ['tenant_id', 'created_by', 'space_id'])
      .addForeignKeyConstraint(
        'space_folder_assignment_space_fkey',
        ['tenant_id', 'created_by', 'space_id'],
        'space',
        ['tenant_id', 'created_by', 'id'],
        fk => fk.onDelete('cascade'),
      )
      .addForeignKeyConstraint(
        'space_folder_assignment_folder_fkey',
        ['tenant_id', 'created_by', 'folder_id'],
        'space_folder',
        ['tenant_id', 'created_by', 'id'],
        fk => fk.onDelete('cascade'),
      )
      .execute();
    await trx.schema
      .createIndex('space_folder_assignment_folder_idx')
      .on('space_folder_assignment')
      .columns(['tenant_id', 'created_by', 'folder_id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('space_folder_assignment').execute();
    await trx.schema.dropTable('space_folder').execute();
  });
}
