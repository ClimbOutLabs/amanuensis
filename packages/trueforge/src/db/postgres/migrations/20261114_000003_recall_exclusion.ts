import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Facts a person pulled out of one chat's recall, stored with the chat so the list survives a
 * restart. Written by POST /api/v1/sessions/{session_id}/recall-exclusions; read by the recall
 * path each turn. The memory itself is never changed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('recall_exclusion')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('session_id', 'text', col => col.notNull())
      .addColumn('fact_text', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .execute();
    await trx.schema
      .createIndex('recall_exclusion_session_idx')
      .on('recall_exclusion')
      .columns(['tenant_id', 'session_id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('recall_exclusion').execute();
  });
}
