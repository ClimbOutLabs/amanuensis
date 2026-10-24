import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

// Existing chats keep a NULL source: they are never retitled automatically.
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('session').addColumn('title_source', 'text').execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('title_source').execute();
  });
}
