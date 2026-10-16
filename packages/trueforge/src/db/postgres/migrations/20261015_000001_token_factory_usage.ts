import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Per-instance daily Token Factory token counter: one row per UTC day (`YYYY-MM-DD`), read and
 * incremented by primary key only. Mirrors db/sqlite/migrations/20261015_000001_token_factory_usage.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('token_factory_usage')
      .addColumn('usage_date', 'text', col => col.notNull())
      .addColumn('used_tokens', 'bigint', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('token_factory_usage_pkey', ['usage_date'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('token_factory_usage').execute();
  });
}
