import { sql, type Kysely } from 'kysely';

/**
 * One Google login per user (their own OAuth client, the refresh token Google issued, and the scopes
 * Google actually granted), plus the single consent a user can have in flight. Mirrors
 * db/postgres/migrations/20261016_000003_google_connection.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE google_connection (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL,
        client_type TEXT NOT NULL CHECK (client_type IN ('desktop', 'web')),
        refresh_token TEXT NOT NULL,
        granted_scopes TEXT NOT NULL,
        account_email TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reconnect')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE google_oauth_pending (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        pkce_verifier TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL,
        client_type TEXT NOT NULL CHECK (client_type IN ('desktop', 'web')),
        redirect_uri TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE google_oauth_pending`.execute(trx);
    await sql`DROP TABLE google_connection`.execute(trx);
  });
}
