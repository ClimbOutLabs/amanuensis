import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('session_folder')
    .addColumn('id', 'text', column => column.primaryKey())
    .addColumn('tenant_id', 'text', column => column.notNull())
    .addColumn('created_by', 'text', column => column.notNull())
    .addColumn('name', 'text', column => column.notNull())
    .addColumn('created_at', 'timestamptz', column => column.notNull())
    .addColumn('updated_at', 'timestamptz', column => column.notNull())
    .execute();
  await db.schema
    .createIndex('session_folder_owner_name_idx')
    .on('session_folder')
    .columns(['tenant_id', 'created_by', 'name', 'id'])
    .execute();
  await db.schema
    .alterTable('session')
    .addColumn('folder_id', 'text', column => column.references('session_folder.id').onDelete('set null'))
    .execute();
  await db.schema
    .createIndex('session_folder_id_idx')
    .on('session')
    .column('folder_id')
    .where('folder_id', 'is not', null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropIndex('session_folder_id_idx').ifExists().execute();
  await db.schema.alterTable('session').dropColumn('folder_id').execute();
  await db.schema.dropTable('session_folder').ifExists().execute();
}
