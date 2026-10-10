import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Per-user standing approvals ("Always allow this tool") for one tool on one connector. Rows
 * are revoked by the user, or for every user when the connector is deleted or its URL changes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('mcp_tool_grant')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('mcp_server_name', 'text', col => col.notNull())
      .addColumn('tool_name', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('mcp_tool_grant_pkey', ['tenant_id', 'created_by', 'mcp_server_name', 'tool_name'])
      .execute();
    await trx.schema
      .createIndex('mcp_tool_grant_server_idx')
      .on('mcp_tool_grant')
      .columns(['tenant_id', 'mcp_server_name'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('mcp_tool_grant').execute();
  });
}
