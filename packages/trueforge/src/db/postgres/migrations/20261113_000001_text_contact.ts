import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The number a person gets texts on, and where confirming it stands: when it was proved, when it was opted out, a new
 * number waiting for its code, and the pending one-time code kept only as a keyed hash with the id of the key, its expiry and attempts.
 * `mode` is plain text so a later choice of words needs no migration. Codes sent are counted in `text_send_count`, apart
 * from the number, so removing a number never resets a limit.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('text_contact')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('phone', 'text', col => col.notNull())
      .addColumn('mode', 'text', col => col.notNull())
      .addColumn('confirmed_at', 'timestamptz')
      .addColumn('opted_out_at', 'timestamptz')
      .addColumn('pending_phone', 'text')
      .addColumn('code_hash', 'text')
      .addColumn('code_salt', 'text')
      .addColumn('code_key_id', 'text')
      .addColumn('code_expires_at', 'timestamptz')
      .addColumn('code_attempts', 'integer', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('text_contact_pk', ['tenant_id', 'created_by'])
      .execute();
    await trx.schema.createIndex('text_contact_phone_idx').on('text_contact').column('phone').execute();
    await trx.schema.createIndex('text_contact_pending_phone_idx').on('text_contact').column('pending_phone').execute();
    await trx.schema
      .createTable('text_send_count')
      .addColumn('scope_key', 'text', col => col.primaryKey())
      .addColumn('window_started_at', 'timestamptz', col => col.notNull())
      .addColumn('sends', 'integer', col => col.notNull())
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('text_send_count').execute();
    await trx.schema.dropTable('text_contact').execute();
  });
}
