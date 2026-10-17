import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Per-model split of the daily Token Factory counter: one row per UTC day and upstream model id.
 * The day row in token_factory_usage stays the cap counter; this table says where its tokens went.
 * Mirrors db/sqlite/migrations/20261015_000002_token_factory_model_usage.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('token_factory_model_usage')
      .addColumn('usage_date', 'text', col => col.notNull())
      .addColumn('model_id', 'text', col => col.notNull())
      .addColumn('input_tokens', 'bigint', col => col.notNull())
      .addColumn('output_tokens', 'bigint', col => col.notNull())
      .addColumn('calls', 'integer', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('token_factory_model_usage_pkey', ['usage_date', 'model_id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('token_factory_model_usage').execute();
  });
}
