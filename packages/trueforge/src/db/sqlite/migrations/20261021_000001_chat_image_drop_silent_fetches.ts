import { sql, type Kysely } from 'kysely';

/**
 * Drops the per-turn silent-fetch counter and keeps only the chat image origins that are still shown.
 * Rows from silent fetches are deleted, since they are the pictures nobody asked for. SQLite cannot
 * change a CHECK in place, so the table is rebuilt and its rows copied across.
 * Mirrors db/postgres/migrations/20261021_000001_chat_image_drop_silent_fetches.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so each migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE chat_image_turn_allowance`.execute(trx);
    await sql`DELETE FROM chat_image WHERE origin = 'remote_silent'`.execute(trx);
    await rebuildChatImage(trx, `'local', 'remote_approved'`);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await rebuildChatImage(trx, `'local', 'remote_silent', 'remote_approved'`);
    await sql`
      CREATE TABLE chat_image_turn_allowance (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        silent_attempts INTEGER NOT NULL CHECK (silent_attempts >= 0),
        PRIMARY KEY (session_id, turn_id)
      ) STRICT
    `.execute(trx);
  });
}

async function rebuildChatImage(trx: Kysely<unknown>, origins: string): Promise<void> {
  await sql
    .raw(
      `
      CREATE TABLE chat_image_rebuilt (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        image_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN (${origins})),
        mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/webp')),
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, image_id),
        UNIQUE (session_id, source_key)
      ) STRICT
    `,
    )
    .execute(trx);
  await sql`
    INSERT INTO chat_image_rebuilt (
      tenant_id, created_by, session_id, turn_id, image_id, source_key,
      origin, mime, width, height, size, data, created_at
    )
    SELECT
      tenant_id, created_by, session_id, turn_id, image_id, source_key,
      origin, mime, width, height, size, data, created_at
    FROM chat_image
  `.execute(trx);
  await sql`DROP TABLE chat_image`.execute(trx);
  await sql`ALTER TABLE chat_image_rebuilt RENAME TO chat_image`.execute(trx);
  await sql`CREATE INDEX chat_image_owner_idx ON chat_image (tenant_id, created_by, created_at)`.execute(trx);
  await sql`CREATE INDEX chat_image_created_idx ON chat_image (created_at)`.execute(trx);
}
