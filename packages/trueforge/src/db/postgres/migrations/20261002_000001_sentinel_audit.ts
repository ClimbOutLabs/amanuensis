import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Sentinel permission audit log: append-only record of tiered tool-call
 * decisions. Entries are written before the action executes. The UI reads
 * them via GET /api/v1/sessions/{id}/audit-log.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('sentinel_audit')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('conversation_id', 'text', col => col.notNull())
      .addColumn('tier', 'integer', col => col.notNull())
      .addColumn('tool_name', 'text', col => col.notNull())
      .addColumn('description', 'text', col => col.notNull())
      .addColumn('outcome', 'text', col => col.notNull())
      .addColumn('auto_deny_reason', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addCheckConstraint('sentinel_audit_tier_check', sql`tier IN (1, 2, 3)`)
      .addCheckConstraint(
        'sentinel_audit_outcome_check',
        sql`outcome IN ('logged', 'ran', 'stopped_by_user', 'undone', 'approved', 'denied', 'auto_denied')`,
      )
      .execute();
    await trx.schema
      .createIndex('sentinel_audit_session_idx')
      .on('sentinel_audit')
      .columns(['tenant_id', 'created_by', 'conversation_id', 'created_at'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('sentinel_audit').execute();
  });
}
