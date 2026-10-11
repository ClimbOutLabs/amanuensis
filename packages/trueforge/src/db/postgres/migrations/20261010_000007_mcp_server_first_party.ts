import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Server-owned trust marker on a stored connector: true only for a connector the product's own
 * setup provisioned. Defaults to false so every existing connector starts untrusted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('mcp_server')
      .addColumn('first_party', 'boolean', col => col.notNull().defaultTo(false))
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('mcp_server').dropColumn('first_party').execute();
  });
}
