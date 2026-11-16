import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Paired terminal keys for the terminal app. Only the hash of each key is stored,
 * with the device name the person saw at pairing, when it was paired and last used,
 * and when it was revoked. Written when a pairing is confirmed in the web app; read
 * on every request a terminal key signs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('terminal_key')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('subject_id', 'text', col => col.notNull())
      .addColumn('subject_type', 'text', col => col.notNull())
      .addColumn('subject_display_name', 'text', col => col.notNull())
      .addColumn('device_name', 'text', col => col.notNull())
      .addColumn('key_hash', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('last_used_at', 'timestamptz', col => col.notNull())
      .addColumn('revoked_at', 'timestamptz')
      .execute();
    await trx.schema.createIndex('terminal_key_hash_idx').unique().on('terminal_key').columns(['key_hash']).execute();
    await trx.schema
      .createIndex('terminal_key_owner_idx')
      .on('terminal_key')
      .columns(['tenant_id', 'subject_id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('terminal_key').execute();
  });
}
