import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/** Durable cross-replica plan dispatch boundary and checkout binding. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('implementation_plan_grant').addColumn('checkout_id', 'text').execute();
    await trx.schema.alterTable('implementation_plan_grant').addColumn('workspace_cwd', 'text').execute();
    await trx.schema.alterTable('implementation_plan_grant').addColumn('revoked_at', 'timestamptz').execute();
    // Grants minted before checkout identity existed are deliberately invalidated.
    await sql`
    UPDATE implementation_plan_grant
    SET revoked_at = now()
    WHERE checkout_id IS NULL OR workspace_cwd IS NULL
  `.execute(trx);
    await trx.schema
      .createTable('implementation_plan_dispatch')
      .addColumn('tenant_id', 'text', column => column.notNull())
      .addColumn('created_by', 'text', column => column.notNull())
      .addColumn('session_id', 'text', column => column.notNull())
      .addColumn('turn_id', 'text', column => column.notNull())
      .addColumn('grant_id', 'text', column => column.notNull())
      .addColumn('workspace_cwd', 'text', column => column.notNull())
      .addColumn('checkout_id', 'text', column => column.notNull())
      .addColumn('dispatch_id', 'text', column => column.notNull())
      .addColumn('state', 'text', column => column.notNull())
      .addColumn('created_at', 'timestamptz', column => column.notNull())
      .addColumn('completed_at', 'timestamptz')
      .addPrimaryKeyConstraint('implementation_plan_dispatch_pkey', ['session_id', 'turn_id', 'dispatch_id'])
      .addForeignKeyConstraint(
        'implementation_plan_dispatch_grant_fkey',
        ['session_id', 'grant_id'],
        'implementation_plan_grant',
        ['session_id', 'grant_id'],
        constraint => constraint.onDelete('cascade'),
      )
      .addForeignKeyConstraint(
        'implementation_plan_dispatch_turn_fkey',
        ['session_id', 'turn_id'],
        'turn',
        ['session_id', 'turn_id'],
        constraint => constraint.onDelete('cascade'),
      )
      .addCheckConstraint('implementation_plan_dispatch_state_check', sql`state IN ('dispatching', 'completed')`)
      .execute();
    await trx.schema
      .createIndex('implementation_plan_dispatch_pending_idx')
      .on('implementation_plan_dispatch')
      .columns(['session_id', 'grant_id', 'state'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('implementation_plan_dispatch').ifExists().cascade().execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('revoked_at').execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('workspace_cwd').execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('checkout_id').execute();
  });
}
