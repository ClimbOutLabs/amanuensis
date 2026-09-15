import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Persisted sandbox-artifact bytes, copied from the sandbox once a turn finishes so a download
 * outlives the sandbox that produced it (the provider auto-stops and later deletes it).
 * `artifact_blob` is content-addressed and deduplicated by digest within a tenant; `turn_artifact`
 * is the per-turn, per-path index the download route looks up.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('artifact_blob')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('digest', 'text', col => col.notNull())
      .addColumn('size', 'integer', col => col.notNull())
      .addColumn('mime', 'text', col => col.notNull())
      .addColumn('data', 'bytea', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('artifact_blob_pkey', ['tenant_id', 'digest'])
      .addCheckConstraint('artifact_blob_size_check', sql`size >= 0`)
      .execute();
    await trx.schema
      .createTable('turn_artifact')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('session_id', 'text', col => col.notNull())
      .addColumn('turn_id', 'text', col => col.notNull())
      .addColumn('path', 'text', col => col.notNull())
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('digest', 'text')
      .addColumn('size', 'integer')
      .addColumn('mime', 'text')
      .addColumn('skip_reason', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('turn_artifact_pkey', ['tenant_id', 'session_id', 'turn_id', 'path'])
      .addCheckConstraint('turn_artifact_status_check', sql`status IN ('stored', 'skipped_size', 'skipped_missing')`)
      .execute();
    await trx.schema
      .createIndex('turn_artifact_session_idx')
      .on('turn_artifact')
      .columns(['tenant_id', 'session_id', 'turn_id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('turn_artifact').execute();
    await trx.schema.dropTable('artifact_blob').execute();
  });
}
