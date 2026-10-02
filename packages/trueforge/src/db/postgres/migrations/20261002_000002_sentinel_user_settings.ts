import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Sentinel per-user settings: Tier 2 "always ask" toggles and offline mode.
 * One row per (tenant_id, created_by). The UI reads/writes via
 * GET/PATCH /api/v1/user/settings/sentinel.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('sentinel_user_settings')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('tier2_always_ask', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('offline_mode', 'boolean', col => col.notNull().defaultTo(false))
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('sentinel_user_settings_pkey', ['tenant_id', 'created_by'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('sentinel_user_settings').execute();
  });
}
