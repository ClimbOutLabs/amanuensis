import { sql, type Kysely } from 'kysely';

/**
 * Binds each standing grant to the connector host it was given for, so a connector whose URL now
 * points elsewhere asks again. Grants recorded before this column carry no binding and are removed,
 * so the next call asks. Mirrors db/postgres/migrations/20261020_000002_mcp_tool_grant_server_host.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`DELETE FROM mcp_tool_grant`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant ADD COLUMN mcp_server_host TEXT`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Rows without a host binding would be trusted across URL changes by the earlier code, so they go.
  await db.transaction().execute(async trx => {
    await sql`DELETE FROM mcp_tool_grant`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant DROP COLUMN mcp_server_host`.execute(trx);
  });
}
