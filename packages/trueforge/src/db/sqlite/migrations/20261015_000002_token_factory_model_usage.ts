import { sql, type Kysely } from 'kysely';

/**
 * Per-model split of the daily Token Factory counter: one row per UTC day and upstream model id.
 * The day row in token_factory_usage stays the cap counter; this table says where its tokens went.
 * Mirrors db/postgres/migrations/20261015_000002_token_factory_model_usage.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE token_factory_model_usage (
        usage_date TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        calls INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (usage_date, model_id)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE token_factory_model_usage`.execute(trx);
  });
}
