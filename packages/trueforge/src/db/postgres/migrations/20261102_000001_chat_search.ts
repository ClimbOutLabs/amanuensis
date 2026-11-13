import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The past-chat search index: one row per searchable message of a finished turn (the person's
 * own words, or the assistant's final reply), with its searchable words (built in code by the
 * shared matching rule, so every store matches alike) in an array the GIN index searches.
 * The index is derived data, rebuilt from the chats, so it is never exported. The session
 * foreign key cascades, so a deleted chat leaves the index at once.
 * Mirrors db/sqlite/migrations/20261102_000001_chat_search.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('chat_search_document')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('session_id', 'text', col => col.notNull().references('session.session_id').onDelete('cascade'))
      .addColumn('turn_id', 'text', col => col.notNull())
      .addColumn('message_id', 'text', col => col.notNull())
      .addColumn('role', 'text', col => col.notNull())
      .addColumn('persona_id', 'text')
      .addColumn('body', 'text', col => col.notNull())
      .addColumn('search_words', sql`text[]`, col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('chat_search_document_pkey', ['tenant_id', 'session_id', 'turn_id', 'message_id'])
      .execute();
    await sql`
      ALTER TABLE chat_search_document
        ADD CONSTRAINT chat_search_document_role_check CHECK (role IN ('user', 'assistant'))
    `.execute(trx);
    await trx.schema
      .createIndex('chat_search_document_search_idx')
      .on('chat_search_document')
      .column('search_words')
      .using('gin')
      .execute();
    await trx.schema
      .createIndex('chat_search_document_session_idx')
      .on('chat_search_document')
      .columns(['tenant_id', 'session_id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('chat_search_document').execute();
  });
}
