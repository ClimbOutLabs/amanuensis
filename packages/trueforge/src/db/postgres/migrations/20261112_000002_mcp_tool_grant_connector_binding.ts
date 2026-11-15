import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Binds each standing grant to the connector's whole setup (see `connectorGrantBinding`) instead of its host, so a
 * connector repointed on the same host, or set to sign in another way, asks again. A grant recorded for a host
 * carries no setup binding, so it is removed and the next call asks, rather than staying listed as Always allowed
 * while it never matches. Mirrors db/sqlite/migrations/20261112_000002_mcp_tool_grant_connector_binding.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`DELETE FROM mcp_tool_grant`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant DROP COLUMN mcp_server_host`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant ADD COLUMN connector_binding text`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`DELETE FROM mcp_tool_grant`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant DROP COLUMN connector_binding`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant ADD COLUMN mcp_server_host text`.execute(trx);
  });
}
