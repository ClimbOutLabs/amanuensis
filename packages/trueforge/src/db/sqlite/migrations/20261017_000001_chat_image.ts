import { sql, type Kysely } from 'kysely';

/**
 * Re-encoded chat images, per user and per chat, and each turn's count of silent remote fetches. The
 * session foreign keys cascade, so deleting a chat deletes both. Mirrors db/postgres/migrations/20261017_000001_chat_image.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE chat_image (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        image_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('local', 'remote_silent', 'remote_approved')),
        mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/webp')),
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, image_id),
        UNIQUE (session_id, source_key)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX chat_image_owner_idx ON chat_image (tenant_id, created_by, created_at)`.execute(trx);
    await sql`CREATE INDEX chat_image_created_idx ON chat_image (created_at)`.execute(trx);
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

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE chat_image_turn_allowance`.execute(trx);
    await sql`DROP TABLE chat_image`.execute(trx);
  });
}
