import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Converges databases that applied the original command-execution migration
 * with databases that briefly received its expanded replacement under the
 * same migration name.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS command_execution (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_revision INTEGER NOT NULL CHECK (repository_revision >= 0),
        command_id TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 3600000),
        status TEXT NOT NULL CHECK (status IN ('running', 'terminal')),
        disposition TEXT CHECK (
          disposition IS NULL OR disposition IN (
            'denied',
            'policy_blocked',
            'executed_ok',
            'executed_nonzero',
            'never_ran',
            'outcome_unknown'
          )
        ),
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        CONSTRAINT command_execution_pkey PRIMARY KEY (session_id, turn_id, tool_call_id),
        CONSTRAINT command_execution_turn_fkey
          FOREIGN KEY (session_id, turn_id) REFERENCES turn(session_id, turn_id) ON DELETE CASCADE,
        CONSTRAINT command_execution_terminal_check CHECK (
          (status = 'running' AND disposition IS NULL AND completed_at IS NULL)
          OR (status = 'terminal' AND disposition IS NOT NULL AND completed_at IS NOT NULL)
        )
      )
    `.execute(trx);
    await sql`
      ALTER TABLE command_execution
        ADD COLUMN IF NOT EXISTS owner_id TEXT,
        ADD COLUMN IF NOT EXISTS lease_id TEXT,
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
    `.execute(trx);
    await sql`
      UPDATE command_execution
      SET
        owner_id = COALESCE(owner_id, 'legacy-migration'),
        lease_id = COALESCE(
          lease_id,
          'legacy-command-execution:' || md5(
            length(session_id)::text || ':' || session_id ||
            length(turn_id)::text || ':' || turn_id ||
            length(thread_id)::text || ':' || thread_id ||
            length(tool_call_id)::text || ':' || tool_call_id
          )
        ),
        lease_expires_at = COALESCE(lease_expires_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')
      WHERE owner_id IS NULL OR lease_id IS NULL OR lease_expires_at IS NULL
    `.execute(trx);
    await sql`
      ALTER TABLE command_execution
        ALTER COLUMN owner_id SET NOT NULL,
        ALTER COLUMN lease_id SET NOT NULL,
        ALTER COLUMN lease_expires_at SET NOT NULL,
        DROP CONSTRAINT IF EXISTS command_execution_pkey,
        DROP CONSTRAINT IF EXISTS command_execution_lease_key,
        ADD CONSTRAINT command_execution_pkey
          PRIMARY KEY (session_id, turn_id, thread_id, tool_call_id),
        ADD CONSTRAINT command_execution_lease_key UNIQUE (lease_id)
    `.execute(trx);
    await sql`DROP INDEX IF EXISTS command_execution_running_idx`.execute(trx);
    await sql`
      CREATE INDEX command_execution_running_idx
        ON command_execution (status, owner_id, lease_expires_at)
        WHERE status = 'running'
    `.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS repository_workspace_verification (
        repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
        workspace_cwd TEXT NOT NULL,
        mutation_epoch INTEGER NOT NULL DEFAULT 0,
        lease_owner_id TEXT,
        lease_id TEXT UNIQUE,
        lease_expires_at TIMESTAMPTZ,
        observation_pending BOOLEAN NOT NULL DEFAULT FALSE,
        receipt_state_sha256 TEXT,
        receipt_command TEXT,
        receipt_created_at TIMESTAMPTZ,
        receipt_result_session_id TEXT,
        receipt_result_turn_id TEXT,
        receipt_result_thread_id TEXT,
        receipt_result_tool_call_id TEXT,
        receipt_result_event_id TEXT,
        CONSTRAINT repository_workspace_verification_pkey PRIMARY KEY (repository_id, workspace_cwd),
        CONSTRAINT repository_workspace_verification_epoch_check CHECK (mutation_epoch >= 0),
        CONSTRAINT repository_workspace_verification_lease_check CHECK (
          (lease_id IS NULL AND lease_owner_id IS NULL AND lease_expires_at IS NULL)
          OR (lease_id IS NOT NULL AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
        ),
        CONSTRAINT repository_workspace_verification_receipt_check CHECK (
          (
            receipt_state_sha256 IS NULL AND receipt_command IS NULL AND receipt_created_at IS NULL
            AND receipt_result_session_id IS NULL AND receipt_result_turn_id IS NULL
            AND receipt_result_thread_id IS NULL AND receipt_result_tool_call_id IS NULL
            AND receipt_result_event_id IS NULL
          )
          OR (
            receipt_state_sha256 IS NOT NULL AND receipt_command IS NOT NULL AND receipt_created_at IS NOT NULL
            AND receipt_result_session_id IS NOT NULL AND receipt_result_turn_id IS NOT NULL
            AND receipt_result_thread_id IS NOT NULL AND receipt_result_tool_call_id IS NOT NULL
            AND receipt_result_event_id IS NOT NULL
          )
        )
      )
    `.execute(trx);
  });
}

/** The original three-column command key cannot represent every repaired row. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    throw new Error('20260901_000001_command_execution_repair is not reversible');
  });
}
