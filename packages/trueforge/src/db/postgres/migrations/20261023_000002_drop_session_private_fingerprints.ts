import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

// Lookups are now judged by where their links came from, which is read from the chat itself, so nothing is kept here.
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('private_fingerprints').execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('session').addColumn('private_fingerprints', 'jsonb').execute();
  });
}
