import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/** Owner-scoped implementation-plan grant durability. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('implementation_plan_grant')
      .addColumn('tenant_id', 'text', column => column.notNull())
      .addColumn('created_by', 'text', column => column.notNull())
      .addColumn('session_id', 'text', column => column.notNull())
      .addColumn('grant_id', 'text', column => column.notNull())
      .addColumn('grant', 'jsonb', column => column.notNull())
      .addColumn('created_at', 'timestamptz', column => column.notNull())
      .addPrimaryKeyConstraint('implementation_plan_grant_pkey', ['session_id', 'grant_id'])
      .addForeignKeyConstraint(
        'implementation_plan_grant_session_fkey',
        ['session_id'],
        'session',
        ['session_id'],
        constraint => constraint.onDelete('cascade'),
      )
      .execute();
    await trx.schema
      .createIndex('implementation_plan_grant_owner_idx')
      .on('implementation_plan_grant')
      .columns(['tenant_id', 'created_by', 'session_id', 'grant_id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('implementation_plan_grant').ifExists().cascade().execute();
  });
}
