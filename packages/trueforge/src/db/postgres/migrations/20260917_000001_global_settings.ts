import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Global key/value settings shared across tenants (e.g. the persisted live
 * tool-output screen override). Small table, point lookups by primary key only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('global_settings')
      .addColumn('key', 'text', col => col.notNull())
      .addColumn('value', 'text', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('global_settings_pkey', ['key'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('global_settings').execute();
  });
}
