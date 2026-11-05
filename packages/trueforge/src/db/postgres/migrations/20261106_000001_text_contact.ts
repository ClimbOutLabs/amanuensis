import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The number a person gets texts on, and where confirming it stands: when it was proved, when it was opted out, and
 * the pending one-time code kept only as a salted hash, with its expiry, attempts and how many were sent this hour.
 * `mode` is plain text so a later choice of words needs no migration.
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
      .addColumn('code_hash', 'text')
      .addColumn('code_salt', 'text')
      .addColumn('code_expires_at', 'timestamptz')
      .addColumn('code_attempts', 'integer', col => col.notNull())
      .addColumn('send_window_started_at', 'timestamptz')
      .addColumn('sends_in_window', 'integer', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('text_contact_pk', ['tenant_id', 'created_by'])
      .execute();
    await trx.schema.createIndex('text_contact_phone_idx').on('text_contact').column('phone').execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('text_contact').execute();
  });
}
