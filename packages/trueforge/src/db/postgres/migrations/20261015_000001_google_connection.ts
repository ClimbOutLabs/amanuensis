import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * One Google login per user (their own OAuth client, the refresh token Google issued, and the scopes
 * Google actually granted), plus the single consent a user can have in flight. Mirrors
 * db/sqlite/migrations/20261015_000001_google_connection.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('google_connection')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('client_id', 'text', col => col.notNull())
      .addColumn('client_secret', 'text', col => col.notNull())
      .addColumn('client_type', 'text', col => col.notNull().check(sql`client_type IN ('desktop', 'web')`))
      .addColumn('refresh_token', 'text', col => col.notNull())
      .addColumn('granted_scopes', 'text', col => col.notNull())
      .addColumn('account_email', 'text')
      .addColumn('status', 'text', col => col.notNull().check(sql`status IN ('connected', 'needs_reconnect')`))
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('google_connection_pkey', ['tenant_id', 'created_by'])
      .execute();
    await trx.schema
      .createTable('google_oauth_pending')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('state_hash', 'text', col => col.notNull())
      .addColumn('pkce_verifier', 'text', col => col.notNull())
      .addColumn('client_id', 'text', col => col.notNull())
      .addColumn('client_secret', 'text', col => col.notNull())
      .addColumn('client_type', 'text', col => col.notNull().check(sql`client_type IN ('desktop', 'web')`))
      .addColumn('redirect_uri', 'text', col => col.notNull())
      .addColumn('scopes', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('google_oauth_pending_pkey', ['tenant_id', 'created_by'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('google_oauth_pending').execute();
    await trx.schema.dropTable('google_connection').execute();
  });
}
