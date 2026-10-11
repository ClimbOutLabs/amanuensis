import { sql, type Kysely } from 'kysely';

/**
 * Durable Sentinel approval tokens, so a pending approval survives a restart. Only the sha256 of
 * the token id is stored. A token redeems once, before expiry, for the tenant and user that minted it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE approval_token (
        token_hash TEXT NOT NULL PRIMARY KEY,
        action_id TEXT NOT NULL,
        params_hash TEXT NOT NULL,
        shell_binding BLOB,
        tenant_id TEXT NOT NULL CHECK (tenant_id <> ''),
        created_by TEXT NOT NULL CHECK (created_by <> ''),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX approval_token_expires_at_idx ON approval_token (expires_at)`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE approval_token`.execute(trx);
  });
}
