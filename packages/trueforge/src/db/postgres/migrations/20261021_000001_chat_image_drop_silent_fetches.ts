import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Drops the per-turn silent-fetch counter and keeps only the chat image origins that are still shown.
 * Rows from silent fetches are deleted, since they are the pictures nobody asked for.
 * Mirrors db/sqlite/migrations/20261021_000001_chat_image_drop_silent_fetches.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('chat_image_turn_allowance').execute();
    await sql`DELETE FROM chat_image WHERE origin = 'remote_silent'`.execute(trx);
    await trx.schema.alterTable('chat_image').dropConstraint('chat_image_origin_check').execute();
    await trx.schema
      .alterTable('chat_image')
      .addCheckConstraint('chat_image_origin_check', sql`origin IN ('local', 'remote_approved')`)
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('chat_image').dropConstraint('chat_image_origin_check').execute();
    await trx.schema
      .alterTable('chat_image')
      .addCheckConstraint('chat_image_origin_check', sql`origin IN ('local', 'remote_silent', 'remote_approved')`)
      .execute();
    await trx.schema
      .createTable('chat_image_turn_allowance')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('session_id', 'text', col => col.notNull().references('session.session_id').onDelete('cascade'))
      .addColumn('turn_id', 'text', col => col.notNull())
      .addColumn('silent_attempts', 'integer', col => col.notNull())
      .addPrimaryKeyConstraint('chat_image_turn_allowance_pkey', ['session_id', 'turn_id'])
      .addCheckConstraint('chat_image_turn_allowance_attempts_check', sql`silent_attempts >= 0`)
      .execute();
  });
}
