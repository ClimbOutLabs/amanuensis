import { sql, type Kysely } from 'kysely';

/**
 * The Telegram channel: one connection per owner (bot, pairing, poll offset), the replies a finished
 * turn still owes Telegram, and the approvals waiting on a button tap. Telegram's numeric ids are
 * text so a 64-bit chat or user id never loses precision. All rows are owner-scoped.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE telegram_connection (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_by_subject TEXT NOT NULL,
        bot_token TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        bot_username TEXT,
        paired_telegram_user_id TEXT,
        paired_chat_id TEXT,
        pairing_code TEXT,
        pairing_expires_at TEXT,
        pairing_telegram_user_id TEXT,
        pairing_chat_id TEXT,
        poll_offset TEXT,
        transport TEXT NOT NULL,
        webhook_secret TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
    await sql`CREATE UNIQUE INDEX telegram_connection_owner_uq ON telegram_connection (tenant_id, created_by)`.execute(
      trx,
    );
    await sql`
      CREATE TABLE telegram_pending_reply (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES telegram_connection (id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
    await sql`CREATE UNIQUE INDEX telegram_pending_reply_turn_uq ON telegram_pending_reply (turn_id)`.execute(trx);
    await sql`CREATE INDEX telegram_pending_reply_created_idx ON telegram_pending_reply (created_at, id)`.execute(trx);
    await sql`
      CREATE TABLE telegram_pending_approval (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES telegram_connection (id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX telegram_pending_approval_turn_idx ON telegram_pending_approval (turn_id)`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE telegram_pending_approval`.execute(trx);
    await sql`DROP TABLE telegram_pending_reply`.execute(trx);
    await sql`DROP TABLE telegram_connection`.execute(trx);
  });
}
