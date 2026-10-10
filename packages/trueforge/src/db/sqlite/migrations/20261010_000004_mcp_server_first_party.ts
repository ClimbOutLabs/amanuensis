import { sql, type Kysely } from 'kysely';

/**
 * Server-owned trust marker on a stored connector: 1 only for a connector the product's own setup
 * provisioned. Defaults to 0 so every existing connector starts untrusted.
 * Mirrors db/postgres/migrations/20261010_000004_mcp_server_first_party.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE mcp_server
        ADD COLUMN first_party INTEGER NOT NULL DEFAULT 0 CHECK (first_party IN (0, 1))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE mcp_server DROP COLUMN first_party`.execute(trx);
  });
}
