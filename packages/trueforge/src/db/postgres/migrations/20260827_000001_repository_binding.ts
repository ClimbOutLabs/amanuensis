import { sql, type Kysely } from 'kysely';

/**
 * Historical repository-binding schema.
 *
 * Keep this migration registered permanently: deployed Postgres databases may
 * already record it as applied, even while the repository surface is absent
 * from a later application build.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's Migrator already invokes this function with a Transaction. Starting
  // another transaction here is unsupported; all statements below share the
  // migrator-owned transaction and roll back together.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('repository')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('clone_url', 'text', col => col.notNull())
    .addColumn('default_branch', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('repository_pkey', ['id'])
    .execute();
  await db.schema
    .createIndex('repository_tenant_name_idx')
    .on('repository')
    .columns(['tenant_id', 'created_by', 'name'])
    .unique()
    .execute();
  await db.schema.alterTable('session').addColumn('repository_id', 'text').execute();
  await db.schema
    .createIndex('session_repository_id_idx')
    .on('session')
    .columns(['tenant_id', 'repository_id'])
    .where('repository_id', 'is not', null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // This is the same migrator-owned transaction described in up().
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`DROP INDEX IF EXISTS session_repository_id_idx`.execute(db);
  await db.schema.alterTable('session').dropColumn('repository_id').execute();
  await db.schema.dropTable('repository').ifExists().cascade().execute();
}
