import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('session')
      .addColumn('task_checklist', 'jsonb', column =>
        column.notNull().defaultTo(sql`'{"revision":0,"items":[]}'::jsonb`),
      )
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('task_checklist').execute();
  });
}
