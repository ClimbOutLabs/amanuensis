import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Re-encoded chat images, per user and per chat. The session foreign key cascades, so deleting a chat
 * deletes them. Mirrors db/sqlite/migrations/20261017_000001_chat_image.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('chat_image')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('session_id', 'text', col => col.notNull().references('session.session_id').onDelete('cascade'))
      .addColumn('turn_id', 'text', col => col.notNull())
      .addColumn('image_id', 'text', col => col.notNull())
      .addColumn('source_key', 'text', col => col.notNull())
      .addColumn('origin', 'text', col => col.notNull())
      .addColumn('mime', 'text', col => col.notNull())
      .addColumn('width', 'integer', col => col.notNull())
      .addColumn('height', 'integer', col => col.notNull())
      .addColumn('size', 'integer', col => col.notNull())
      .addColumn('data', 'bytea', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('chat_image_pkey', ['session_id', 'image_id'])
      .addUniqueConstraint('chat_image_source_key', ['session_id', 'source_key'])
      .addCheckConstraint('chat_image_origin_check', sql`origin IN ('local', 'remote_approved')`)
      .addCheckConstraint('chat_image_mime_check', sql`mime IN ('image/png', 'image/webp')`)
      .addCheckConstraint('chat_image_size_check', sql`size >= 0`)
      .execute();
    await trx.schema
      .createIndex('chat_image_owner_idx')
      .on('chat_image')
      .columns(['tenant_id', 'created_by', 'created_at'])
      .execute();
    await trx.schema.createIndex('chat_image_created_idx').on('chat_image').column('created_at').execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('chat_image').execute();
  });
}
