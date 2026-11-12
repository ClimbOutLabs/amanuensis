import { sql, type Kysely } from 'kysely';

/**
 * Binds each standing grant to the connector's whole setup (see `connectorGrantBinding`) instead of its host, so a
 * connector repointed on the same host, or set to sign in another way, asks again. A grant recorded for a host
 * carries no setup binding, so it is removed and the next call asks, rather than staying listed as Always allowed
 * while it never matches. Mirrors db/postgres/migrations/20261105_000001_mcp_tool_grant_connector_binding.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`DELETE FROM mcp_tool_grant`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant DROP COLUMN mcp_server_host`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant ADD COLUMN connector_binding TEXT`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // A grant bound to a setup has no host the earlier code could compare, so it goes.
  await db.transaction().execute(async trx => {
    await sql`DELETE FROM mcp_tool_grant`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant DROP COLUMN connector_binding`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant ADD COLUMN mcp_server_host TEXT`.execute(trx);
  });
}
