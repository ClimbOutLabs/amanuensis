import { sql, type Kysely } from 'kysely';

const LEGACY_LEASE_EXPIRY = '1970-01-01T00:00:00.000Z';

/**
 * Converges databases that applied the original command-execution migration
 * with databases that briefly received its expanded replacement under the
 * same migration name.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      const columns = await sql<{ name: string }>`PRAGMA table_info(command_execution)`.execute(trx);
      const hasCommandExecutionTable = columns.rows.length > 0;
      const hasOwnershipColumns = columns.rows.some(column => column.name === 'owner_id');

      if (!hasOwnershipColumns) {
        await sql`
          CREATE TABLE command_execution_repaired (
            session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
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
            owner_id TEXT NOT NULL,
            lease_id TEXT NOT NULL,
            lease_expires_at TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            PRIMARY KEY (session_id, turn_id, thread_id, tool_call_id),
            UNIQUE (lease_id),
            FOREIGN KEY (session_id, turn_id) REFERENCES turn(session_id, turn_id) ON DELETE CASCADE,
            CHECK (
              (status = 'running' AND disposition IS NULL AND completed_at IS NULL)
              OR (status = 'terminal' AND disposition IS NOT NULL AND completed_at IS NOT NULL)
            )
          ) STRICT
        `.execute(trx);
        if (hasCommandExecutionTable) {
          await sql`
            INSERT INTO command_execution_repaired (
              session_id, turn_id, thread_id, tool_call_id, tool_name,
              repository_id, repository_revision, command_id, command, cwd,
              timeout_ms, status, disposition, owner_id, lease_id,
              lease_expires_at, started_at, completed_at
            )
            SELECT
              session_id, turn_id, thread_id, tool_call_id, tool_name,
              repository_id, repository_revision, command_id, command, cwd,
              timeout_ms, status, disposition, 'legacy-migration',
              'legacy-command-execution:' || rowid,
              ${LEGACY_LEASE_EXPIRY}, started_at, completed_at
            FROM command_execution
          `.execute(trx);
        }
        await sql`DROP INDEX IF EXISTS command_execution_running_idx`.execute(trx);
        await sql`DROP TABLE IF EXISTS command_execution`.execute(trx);
        await sql`ALTER TABLE command_execution_repaired RENAME TO command_execution`.execute(trx);
      }

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
          mutation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (mutation_epoch >= 0),
          lease_owner_id TEXT,
          lease_id TEXT UNIQUE,
          lease_expires_at TEXT,
          observation_pending INTEGER NOT NULL DEFAULT 0 CHECK (observation_pending IN (0, 1)),
          receipt_state_sha256 TEXT,
          receipt_command TEXT,
          receipt_created_at TEXT,
          receipt_result_session_id TEXT,
          receipt_result_turn_id TEXT,
          receipt_result_thread_id TEXT,
          receipt_result_tool_call_id TEXT,
          receipt_result_event_id TEXT,
          PRIMARY KEY (repository_id, workspace_cwd),
          CHECK (
            (lease_id IS NULL AND lease_owner_id IS NULL AND lease_expires_at IS NULL)
            OR (lease_id IS NOT NULL AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
          ),
          CHECK (
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
        ) STRICT
      `.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

/** The original three-column command key cannot represent every repaired row. */
export function down(): Promise<void> {
  return Promise.reject(new Error('20260901_000001_command_execution_repair is not reversible'));
}
