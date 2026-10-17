import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * A standing tool grant belongs to the connector as configured when it was chosen: its id and a
 * digest of its URL and auth settings. Rows from before this migration carry empty values and
 * adopt the connector's current identity the first time they are used.
 * Mirrors db/sqlite/migrations/20261016_000001_mcp_tool_grant_connector.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('mcp_tool_grant')
      .addColumn('mcp_server_id', 'text', col => col.notNull().defaultTo(''))
      .addColumn('connector_fingerprint', 'text', col => col.notNull().defaultTo(''))
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('mcp_tool_grant')
      .dropColumn('connector_fingerprint')
      .dropColumn('mcp_server_id')
      .execute();
  });
}
