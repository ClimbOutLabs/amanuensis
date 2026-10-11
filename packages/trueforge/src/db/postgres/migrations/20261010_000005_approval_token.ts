import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Durable Sentinel approval tokens, so a pending approval survives a restart and is redeemable on
 * any replica. Only the sha256 of the token id is stored. A token redeems once, before expiry, for
 * the tenant and user that minted it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('approval_token')
      .addColumn('token_hash', 'text', col => col.primaryKey())
      .addColumn('action_id', 'text', col => col.notNull())
      .addColumn('params_hash', 'text', col => col.notNull())
      .addColumn('shell_binding', 'jsonb')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('expires_at', 'timestamptz', col => col.notNull())
      .addColumn('used_at', 'timestamptz')
      .addCheckConstraint('approval_token_tenant_id_nonempty', sql`tenant_id <> ''`)
      .addCheckConstraint('approval_token_created_by_nonempty', sql`created_by <> ''`)
      .execute();
    await trx.schema.createIndex('approval_token_expires_at_idx').on('approval_token').column('expires_at').execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('approval_token').execute();
  });
}
