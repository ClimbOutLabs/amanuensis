import { sql, type Kysely } from 'kysely';

/**
 * The past-chat search index: one row per searchable message of a finished turn (the person's
 * own words, or the assistant's final reply), plus the FTS5 table that searches the words.
 * The index is derived data, rebuilt from the chats, so it is never exported. The session
 * foreign key cascades, so a deleted chat leaves the index at once. Triggers keep the FTS5
 * table in step with the document rows inside the same transaction.
 * Mirrors db/postgres/migrations/20261031_000001_chat_search.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE chat_search_document (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, turn_id, message_id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX chat_search_document_session_idx ON chat_search_document (tenant_id, session_id)
    `.execute(trx);
    await sql`
      CREATE VIRTUAL TABLE chat_search_fts USING fts5(
        body,
        content='chat_search_document',
        content_rowid='rowid',
        tokenize='porter unicode61'
      )
    `.execute(trx);
    await sql`
      CREATE TRIGGER chat_search_document_ai AFTER INSERT ON chat_search_document BEGIN
        INSERT INTO chat_search_fts (rowid, body) VALUES (new.rowid, new.body);
      END
    `.execute(trx);
    await sql`
      CREATE TRIGGER chat_search_document_ad AFTER DELETE ON chat_search_document BEGIN
        INSERT INTO chat_search_fts (chat_search_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      END
    `.execute(trx);
    await sql`
      INSERT INTO chat_search_fts (chat_search_fts) VALUES ('rebuild')
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TRIGGER IF EXISTS chat_search_document_ai`.execute(trx);
    await sql`DROP TRIGGER IF EXISTS chat_search_document_ad`.execute(trx);
    await sql`DROP TABLE IF EXISTS chat_search_fts`.execute(trx);
    await sql`DROP TABLE IF EXISTS chat_search_document`.execute(trx);
  });
}
