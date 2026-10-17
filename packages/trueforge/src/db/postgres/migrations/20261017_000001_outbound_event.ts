import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Record of requests that left this computer: model requests, emails, searches, map lookups and
 * connector calls. Hosts and sizes only, never request text. Mirrors
 * db/sqlite/migrations/20261017_000001_outbound_event.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('outbound_event')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('kind', 'text', col => col.notNull())
      .addColumn('host', 'text', col => col.notNull())
      .addColumn('model', 'text')
      .addColumn('tool_name', 'text')
      .addColumn('request_bytes', 'integer')
      .addColumn('recipient_count', 'integer')
      .addColumn('subject', 'text')
      .addColumn('conversation_id', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addCheckConstraint(
        'outbound_event_kind_check',
        sql`kind IN ('model_request', 'email_sent', 'web_search', 'map_lookup', 'connector_call')`,
      )
      .execute();
    await trx.schema
      .createIndex('outbound_event_created_idx')
      .on('outbound_event')
      .columns(['tenant_id', 'created_at'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('outbound_event').execute();
  });
}
