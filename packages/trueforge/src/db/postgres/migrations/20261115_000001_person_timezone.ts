import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/** The time zone each person's browser last gave, so a message that brings none is still read in their own day. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('person_timezone')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('timezone', 'text', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('person_timezone_pk', ['tenant_id', 'created_by'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('person_timezone').execute();
  });
}
