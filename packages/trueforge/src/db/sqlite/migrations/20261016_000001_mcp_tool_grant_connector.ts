import { sql, type Kysely } from 'kysely';

/**
 * A standing tool grant belongs to the connector as configured when it was chosen: its id and a
 * digest of its URL and auth settings. Rows from before this migration carry empty values and
 * adopt the connector's current identity the first time they are used.
 * Mirrors db/postgres/migrations/20261016_000001_mcp_tool_grant_connector.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE mcp_tool_grant ADD COLUMN mcp_server_id TEXT NOT NULL DEFAULT ''`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant ADD COLUMN connector_fingerprint TEXT NOT NULL DEFAULT ''`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE mcp_tool_grant DROP COLUMN connector_fingerprint`.execute(trx);
    await sql`ALTER TABLE mcp_tool_grant DROP COLUMN mcp_server_id`.execute(trx);
  });
}
