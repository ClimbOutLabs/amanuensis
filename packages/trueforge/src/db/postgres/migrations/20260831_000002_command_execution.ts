import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/** Durable lifecycle for one registered verification command. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('command_execution')
      .addColumn('session_id', 'text', column => column.notNull())
      .addColumn('turn_id', 'text', column => column.notNull())
      .addColumn('thread_id', 'text', column => column.notNull())
      .addColumn('tool_call_id', 'text', column => column.notNull())
      .addColumn('tool_name', 'text', column => column.notNull())
      .addColumn('repository_id', 'text', column => column.notNull())
      .addColumn('repository_revision', 'integer', column => column.notNull())
      .addColumn('command_id', 'text', column => column.notNull())
      .addColumn('command', 'text', column => column.notNull())
      .addColumn('cwd', 'text', column => column.notNull())
      .addColumn('timeout_ms', 'integer', column => column.notNull())
      .addColumn('status', 'text', column => column.notNull())
      .addColumn('disposition', 'text')
      .addColumn('started_at', 'timestamptz', column => column.notNull())
      .addColumn('completed_at', 'timestamptz')
      .addPrimaryKeyConstraint('command_execution_pkey', ['session_id', 'turn_id', 'tool_call_id'])
      .addForeignKeyConstraint(
        'command_execution_turn_fkey',
        ['session_id', 'turn_id'],
        'turn',
        ['session_id', 'turn_id'],
        constraint => constraint.onDelete('cascade'),
      )
      .execute();
    await sql`
    ALTER TABLE command_execution
      ADD CONSTRAINT command_execution_revision_check CHECK (repository_revision >= 0),
      ADD CONSTRAINT command_execution_timeout_check CHECK (timeout_ms BETWEEN 1 AND 3600000),
      ADD CONSTRAINT command_execution_status_check CHECK (status IN ('running', 'terminal')),
      ADD CONSTRAINT command_execution_disposition_check CHECK (
        disposition IS NULL OR disposition IN (
          'denied',
          'policy_blocked',
          'executed_ok',
          'executed_nonzero',
          'never_ran',
          'outcome_unknown'
        )
      ),
      ADD CONSTRAINT command_execution_terminal_check CHECK (
        (status = 'running' AND disposition IS NULL AND completed_at IS NULL)
        OR (status = 'terminal' AND disposition IS NOT NULL AND completed_at IS NOT NULL)
      )
  `.execute(trx);
    await trx.schema
      .createIndex('command_execution_running_idx')
      .on('command_execution')
      .columns(['status', 'session_id', 'turn_id'])
      .where('status', '=', 'running')
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('command_execution').ifExists().cascade().execute();
  });
}
