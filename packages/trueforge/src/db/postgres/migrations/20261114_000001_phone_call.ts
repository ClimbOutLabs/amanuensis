import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The phone calls Aman placed: Twilio's id for each, where it stands, how it ended, the chat it was written in, and
 * the one-time media token kept only as a hash while it waits to be used. Status, outcome and mode are plain text so
 * a later value needs no migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('phone_call')
      .addColumn('id', 'text', col => col.primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('delivery_id', 'text', col => col.notNull())
      .addColumn('call_sid', 'text')
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('outcome', 'text')
      .addColumn('mode', 'text')
      .addColumn('session_id', 'text')
      .addColumn('fallback', 'text', col => col.notNull())
      .addColumn('token_hash', 'text')
      .addColumn('token_expires_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('expires_at', 'timestamptz', col => col.notNull())
      .addColumn('ended_at', 'timestamptz')
      .execute();
    await trx.schema.createIndex('phone_call_call_sid_idx').on('phone_call').column('call_sid').unique().execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('phone_call').execute();
  });
}
