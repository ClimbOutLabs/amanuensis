import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * `format` on `space`: `markdown` (default) or `html`. `20260913_000001_space` already shipped
 * (build fe3d8653) without this column, so it is added here rather than edited in place.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('space')
      .addColumn('format', 'text', col => col.notNull().defaultTo('markdown'))
      .execute();
    await trx.schema
      .alterTable('space')
      .addCheckConstraint('space_format_check', sql`format IN ('markdown', 'html')`)
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('space').dropConstraint('space_format_check').execute();
    await trx.schema.alterTable('space').dropColumn('format').execute();
  });
}
