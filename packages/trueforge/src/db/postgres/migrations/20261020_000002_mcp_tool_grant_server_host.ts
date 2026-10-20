import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Binds each standing grant to the connector host it was given for, so a connector whose URL now
 * points elsewhere asks again. Grants recorded before this column carry no binding and are removed,
 * so the next call asks. Mirrors db/sqlite/migrations/20261020_000002_mcp_tool_grant_server_host.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`DELETE FROM mcp_tool_grant`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant ADD COLUMN mcp_server_host text`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`DELETE FROM mcp_tool_grant`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant DROP COLUMN mcp_server_host`.execute(trx);
  });
}
