import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The Telegram channel: one connection per owner (bot, pairing, poll offset), the replies a finished
 * turn still owes Telegram, and the approvals waiting on a button tap. Telegram's numeric ids are
 * text so a 64-bit chat or user id never loses precision. All rows are owner-scoped.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('telegram_connection')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('created_by_subject', 'text', col => col.notNull())
      .addColumn('bot_token', 'text', col => col.notNull())
      .addColumn('bot_id', 'text', col => col.notNull())
      .addColumn('bot_name', 'text', col => col.notNull())
      .addColumn('bot_username', 'text')
      .addColumn('paired_telegram_user_id', 'text')
      .addColumn('paired_chat_id', 'text')
      .addColumn('pairing_code', 'text')
      .addColumn('pairing_expires_at', 'timestamptz')
      .addColumn('pairing_telegram_user_id', 'text')
      .addColumn('pairing_chat_id', 'text')
      .addColumn('poll_offset', 'text')
      .addColumn('transport', 'text', col => col.notNull())
      .addColumn('webhook_secret', 'text')
      .addColumn('session_id', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .execute();
    await trx.schema
      .createIndex('telegram_connection_owner_uq')
      .unique()
      .on('telegram_connection')
      .columns(['tenant_id', 'created_by'])
      .execute();
    await trx.schema
      .createTable('telegram_pending_reply')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('connection_id', 'text', col => col.notNull().references('telegram_connection.id').onDelete('cascade'))
      .addColumn('session_id', 'text', col => col.notNull())
      .addColumn('turn_id', 'text', col => col.notNull())
      .addColumn('chat_id', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .execute();
    await trx.schema
      .createIndex('telegram_pending_reply_turn_uq')
      .unique()
      .on('telegram_pending_reply')
      .column('turn_id')
      .execute();
    await trx.schema
      .createIndex('telegram_pending_reply_created_idx')
      .on('telegram_pending_reply')
      .columns(['created_at', 'id'])
      .execute();
    await trx.schema
      .createTable('telegram_pending_approval')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('connection_id', 'text', col => col.notNull().references('telegram_connection.id').onDelete('cascade'))
      .addColumn('session_id', 'text', col => col.notNull())
      .addColumn('turn_id', 'text', col => col.notNull())
      .addColumn('thread_id', 'text', col => col.notNull())
      .addColumn('tool_call_id', 'text', col => col.notNull())
      .addColumn('chat_id', 'text', col => col.notNull())
      .addColumn('prompt', 'text', col => col.notNull())
      .addColumn('expires_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .execute();
    await trx.schema
      .createIndex('telegram_pending_approval_turn_idx')
      .on('telegram_pending_approval')
      .column('turn_id')
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('telegram_pending_approval').execute();
    await trx.schema.dropTable('telegram_pending_reply').execute();
    await trx.schema.dropTable('telegram_connection').execute();
  });
}
