import { sql, type Kysely } from 'kysely';

/** Durable lifecycle for one registered verification command. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE command_execution (
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
        started_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (session_id, turn_id, tool_call_id),
        FOREIGN KEY (session_id, turn_id) REFERENCES turn(session_id, turn_id) ON DELETE CASCADE,
        CHECK (
          (status = 'running' AND disposition IS NULL AND completed_at IS NULL)
          OR (status = 'terminal' AND disposition IS NOT NULL AND completed_at IS NOT NULL)
        )
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX command_execution_running_idx
        ON command_execution (status, session_id, turn_id)
        WHERE status = 'running'
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS command_execution`.execute(trx);
  });
}
