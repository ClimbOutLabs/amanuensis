import { sql, type Kysely } from 'kysely';

/**
 * Per-user standing approvals ("Always allow this tool") for one tool on one connector. Rows
 * are revoked by the user, or for every user when the connector is deleted or its URL changes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE mcp_tool_grant (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        mcp_server_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by, mcp_server_name, tool_name)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX mcp_tool_grant_server_idx
      ON mcp_tool_grant (tenant_id, mcp_server_name)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE mcp_tool_grant`.execute(trx);
  });
}
