import { sql, type Kysely } from 'kysely';
import { DELETED_CHAT_MODEL_USAGE_OWNER_IDX, SESSION_PRIVATE_EXPIRY_IDX } from '../../indexes';
import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Private chats. `is_incognito` is fixed when the chat is created; a private chat always has a
 * `private_expires_at` and any other chat never has one, which the check constraint holds. The
 * partial index serves the sweep that deletes private chats past that time. Existing chats are
 * not private. `deleted_chat_model_usage` keeps the token counts and cost of a deleted chat's model
 * calls, with no session id and no words, so usage totals stay right after a chat is gone. Mirrors db/sqlite/migrations/20261105_000001_private_chats.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('session')
      .addColumn('is_incognito', 'boolean', col => col.notNull().defaultTo(false))
      .addColumn('private_expires_at', 'timestamptz')
      .execute();
    await sql`
      ALTER TABLE session ADD CONSTRAINT session_private_expiry_check
        CHECK (is_incognito = (private_expires_at IS NOT NULL))
    `.execute(trx);
    await sql`
      CREATE INDEX ${sql.raw(SESSION_PRIVATE_EXPIRY_IDX)} ON session (private_expires_at) WHERE is_incognito
    `.execute(trx);
    await sql`
      CREATE TABLE deleted_chat_model_usage (
        tenant_id text NOT NULL,
        event_id text NOT NULL,
        created_by_subject_id text NOT NULL,
        model_id text NOT NULL,
        display_name text NOT NULL,
        input_tokens integer NOT NULL CHECK (input_tokens >= 0),
        output_tokens integer NOT NULL CHECK (output_tokens >= 0),
        cost_usd double precision CHECK (cost_usd IS NULL OR cost_usd >= 0),
        created_at timestamptz NOT NULL,
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
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`DROP TABLE IF EXISTS deleted_chat_model_usage`.execute(trx);
    await sql`DROP INDEX IF EXISTS ${sql.raw(SESSION_PRIVATE_EXPIRY_IDX)}`.execute(trx);
    await sql`ALTER TABLE session DROP CONSTRAINT IF EXISTS session_private_expiry_check`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('private_expires_at').dropColumn('is_incognito').execute();
  });
}
