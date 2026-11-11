import { sql, type Kysely } from 'kysely';
import { DELETED_CHAT_MODEL_USAGE_OWNER_IDX, SESSION_PRIVATE_EXPIRY_IDX } from '../../indexes';

/**
 * Private chats. `is_incognito` is fixed when the chat is created; a private chat always has a
 * `private_expires_at` and any other chat never has one, which the column check holds. The partial
 * index serves the sweep that deletes private chats past that time. Existing chats are not private.
 * `deleted_chat_model_usage` keeps the token counts and cost of a deleted chat's model calls, with
 * no session id and no words, so usage totals stay right after a chat is gone.
 * Mirrors db/postgres/migrations/20261105_000001_private_chats.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE session
        ADD COLUMN is_incognito INTEGER NOT NULL DEFAULT 0 CHECK (is_incognito IN (0, 1))
    `.execute(trx);
    await sql`
      ALTER TABLE session
        ADD COLUMN private_expires_at TEXT CHECK ((is_incognito = 1) = (private_expires_at IS NOT NULL))
    `.execute(trx);
    await sql`
      CREATE INDEX ${sql.raw(SESSION_PRIVATE_EXPIRY_IDX)} ON session (private_expires_at) WHERE is_incognito = 1
    `.execute(trx);
    await sql`
      CREATE TABLE deleted_chat_model_usage (
        tenant_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_by_subject_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, event_id)
      )
    `.execute(trx);
    await sql`
      CREATE INDEX ${sql.raw(DELETED_CHAT_MODEL_USAGE_OWNER_IDX)}
        ON deleted_chat_model_usage (tenant_id, created_by_subject_id, created_at)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS deleted_chat_model_usage`.execute(trx);
    await sql`DROP INDEX IF EXISTS ${sql.raw(SESSION_PRIVATE_EXPIRY_IDX)}`.execute(trx);
    await sql`ALTER TABLE session DROP COLUMN private_expires_at`.execute(trx);
    await sql`ALTER TABLE session DROP COLUMN is_incognito`.execute(trx);
  });
}
