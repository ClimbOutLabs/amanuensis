import type { CreateTurnInput } from '@truefoundry/trueforge-core/agent-session';
import { AgentSpecSchema, MAIN_THREAD_ID, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { sql } from 'kysely';

import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';

const PERSONA_MIGRATION = '20260827_000001_persona';
const REPOSITORY_MIGRATION = '20260827_000001_repository_binding';
const COMMAND_EXECUTION_REPAIR = '20260901_000001_command_execution_repair';

function runningTurnInput(input: { sessionId: string; turnId: string }): CreateTurnInput {
  const { sessionId, turnId } = input;
  const now = new Date('2026-09-01T00:00:00.000Z');
  return {
    turn: {
      session_id: sessionId,
      turn_id: turnId,
      first_turn_id: turnId,
      previous_turn_id: null,
      ancestor_ids: [],
      input: [],
      state: { status: 'running' },
      custom: null,
      created_at: now,
      updated_at: now,
    },
    approval_grants: [],
    require_previous_turn_is_tip: false,
    retained_previous_thread_ids: [],
    new_threads: [{ thread_id: MAIN_THREAD_ID, parent: null, agent_info: null, tool_call_memo: undefined }],
    new_context_appends: [],
    capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: null }],
    tool_call_memos: [],
    sandbox_info: null,
    update_session_title_if_not_exist: null,
  };
}

describe('migrateSqliteToLatest', () => {
  it('accepts the historical repository-before-persona upgrade order', async () => {
    const db = createSqliteDb(':memory:');

    try {
      await migrateSqliteToLatest(db);

      const applied = await sql<{ name: string }>`
        SELECT name FROM kysely_migration ORDER BY name
      `.execute(db);
      const names = applied.rows.map(row => row.name);
      const personaIndex = names.indexOf(PERSONA_MIGRATION);
      const repositoryIndex = names.indexOf(REPOSITORY_MIGRATION);

      expect(personaIndex).toBeGreaterThanOrEqual(0);
      expect(repositoryIndex).toBeGreaterThanOrEqual(0);

      const historicalOrder = names.filter(name => name !== PERSONA_MIGRATION && name !== REPOSITORY_MIGRATION);
      historicalOrder.splice(Math.min(personaIndex, repositoryIndex), 0, REPOSITORY_MIGRATION, PERSONA_MIGRATION);

      for (const [index, name] of historicalOrder.entries()) {
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        await sql`
          UPDATE kysely_migration
          SET timestamp = ${timestamp}
          WHERE name = ${name}
        `.execute(db);
      }

      await expect(migrateSqliteToLatest(db)).resolves.toBeUndefined();

      const after = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(db);
      expect(after.rows).toHaveLength(names.length);
      expect(new Set(after.rows.map(row => row.name)).size).toBe(names.length);
    } finally {
      await db.destroy();
    }
  });

  it('repairs a database that already recorded the original command-execution migration', async () => {
    const db = createSqliteDb(':memory:');

    try {
      await migrateSqliteToLatest(db);
      const sessionId = 'migration-session';
      const turnId = 'migration-turn';
      const toolCallId = 'migration-tool-call';
      const sessionStore = new SqliteSessionStore(db);
      const sessions = new Sessions({ sessionStore });
      await sessions.create({
        tenant_id: 'default',
        session_id: sessionId,
        created_by_subject: {
          subject_id: 'migration-test',
          subject_type: 'user',
          subject_display_name: 'migration-test',
        },
        external_id: null,
        agent: {
          type: 'inline',
          spec: AgentSpecSchema.parse({
            model: { name: 'test-provider/test-model' },
            instructions: 'Migration test agent.',
          }),
        },
      });
      await sessionStore.createTurn(runningTurnInput({ sessionId, turnId }));
      await db
        .insertInto('command_execution')
        .values({
          session_id: sessionId,
          turn_id: turnId,
          thread_id: MAIN_THREAD_ID,
          tool_call_id: toolCallId,
          tool_name: 'repository.exec',
          repository_id: 'repository-1',
          repository_revision: 1,
          command_id: 'verify',
          command: 'pnpm verify',
          cwd: '/workspace',
          timeout_ms: 60_000,
          status: 'running',
          disposition: null,
          owner_id: 'current-owner',
          lease_id: 'current-lease',
          lease_expires_at: '2026-09-01T00:01:00.000Z',
          started_at: '2026-09-01T00:00:00.000Z',
          completed_at: null,
        })
        .execute();

      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      try {
        await db.transaction().execute(async trx => {
          await sql`DROP TABLE repository_workspace_verification`.execute(trx);
          await sql`
            CREATE TABLE command_execution_original (
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
            INSERT INTO command_execution_original (
              session_id, turn_id, thread_id, tool_call_id, tool_name,
              repository_id, repository_revision, command_id, command, cwd,
              timeout_ms, status, disposition, started_at, completed_at
            )
            SELECT
              session_id, turn_id, thread_id, tool_call_id, tool_name,
              repository_id, repository_revision, command_id, command, cwd,
              timeout_ms, status, disposition, started_at, completed_at
            FROM command_execution
          `.execute(trx);
          await sql`DROP INDEX command_execution_running_idx`.execute(trx);
          await sql`DROP TABLE command_execution`.execute(trx);
          await sql`ALTER TABLE command_execution_original RENAME TO command_execution`.execute(trx);
          await sql`
            CREATE INDEX command_execution_running_idx
              ON command_execution (status, session_id, turn_id)
              WHERE status = 'running'
          `.execute(trx);
          await sql`DELETE FROM kysely_migration WHERE name = ${COMMAND_EXECUTION_REPAIR}`.execute(trx);
        });
      } finally {
        await sql`PRAGMA foreign_keys = ON`.execute(db);
      }

      await expect(migrateSqliteToLatest(db)).resolves.toBeUndefined();

      const repaired = await sql<{
        session_id: string;
        turn_id: string;
        thread_id: string;
        tool_call_id: string;
        tool_name: string;
        repository_id: string;
        repository_revision: number;
        command_id: string;
        command: string;
        cwd: string;
        timeout_ms: number;
        status: string;
        disposition: string | null;
        owner_id: string;
        lease_id: string;
        lease_expires_at: string;
        started_at: string;
        completed_at: string | null;
      }>`
        SELECT *
        FROM command_execution
        WHERE session_id = ${sessionId} AND turn_id = ${turnId} AND tool_call_id = ${toolCallId}
      `.execute(db);
      expect(repaired.rows).toEqual([
        {
          session_id: sessionId,
          turn_id: turnId,
          thread_id: MAIN_THREAD_ID,
          tool_call_id: toolCallId,
          tool_name: 'repository.exec',
          repository_id: 'repository-1',
          repository_revision: 1,
          command_id: 'verify',
          command: 'pnpm verify',
          cwd: '/workspace',
          timeout_ms: 60_000,
          status: 'running',
          disposition: null,
          owner_id: 'legacy-migration',
          lease_id: 'legacy-command-execution:1',
          lease_expires_at: '1970-01-01T00:00:00.000Z',
          started_at: '2026-09-01T00:00:00.000Z',
          completed_at: null,
        },
      ]);
      const columns = await sql<{ name: string; pk: number }>`PRAGMA table_info(command_execution)`.execute(db);
      expect(columns.rows.filter(column => column.pk > 0).map(column => column.name)).toEqual([
        'session_id',
        'turn_id',
        'thread_id',
        'tool_call_id',
      ]);
      const workspaceTable = await sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'repository_workspace_verification'
      `.execute(db);
      expect(workspaceTable.rows).toEqual([{ name: 'repository_workspace_verification' }]);
      await expect(
        sql`
          UPDATE command_execution
          SET status = 'terminal', disposition = 'not-a-disposition', completed_at = '2026-09-01T00:02:00.000Z'
          WHERE session_id = ${sessionId} AND turn_id = ${turnId} AND tool_call_id = ${toolCallId}
        `.execute(db),
      ).rejects.toThrow();
      await expect(
        sql`
          UPDATE command_execution SET status = 'terminal'
          WHERE session_id = ${sessionId} AND turn_id = ${turnId} AND tool_call_id = ${toolCallId}
        `.execute(db),
      ).rejects.toThrow();
      await expect(
        sessionStore.recoverRunningCommandExecutions({
          completed_at: new Date('2026-09-01T00:02:00.000Z'),
          owner_ids: ['legacy-migration'],
          require_expired_lease: true,
        }),
      ).resolves.toBe(1);
      await expect(migrateSqliteToLatest(db)).resolves.toBeUndefined();
      const repairRows = await sql<{ count: number }>`
        SELECT count(*) AS count FROM kysely_migration WHERE name = ${COMMAND_EXECUTION_REPAIR}
      `.execute(db);
      expect(repairRows.rows).toEqual([{ count: 1 }]);
    } finally {
      await db.destroy();
    }
  });

  it('accepts an already-expanded command-execution schema whose repair row is missing', async () => {
    const db = createSqliteDb(':memory:');

    try {
      await migrateSqliteToLatest(db);
      const sessionId = 'expanded-schema-session';
      const turnId = 'expanded-schema-turn';
      const repositoryId = 'expanded-schema-repository';
      const sessionStore = new SqliteSessionStore(db);
      const sessions = new Sessions({ sessionStore });
      await db
        .insertInto('repository')
        .values({
          id: repositoryId,
          tenant_id: 'default',
          created_by: 'migration-test',
          name: 'expanded-schema',
          clone_url: 'https://example.invalid/expanded-schema.git',
          default_branch: 'main',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        })
        .execute();
      await sessions.create({
        tenant_id: 'default',
        session_id: sessionId,
        created_by_subject: {
          subject_id: 'migration-test',
          subject_type: 'user',
          subject_display_name: 'migration-test',
        },
        external_id: null,
        agent: {
          type: 'inline',
          spec: AgentSpecSchema.parse({
            model: { name: 'test-provider/test-model' },
            instructions: 'Expanded schema migration test agent.',
          }),
        },
      });
      await sessionStore.createTurn(runningTurnInput({ sessionId, turnId }));
      await db
        .insertInto('command_execution')
        .values({
          session_id: sessionId,
          turn_id: turnId,
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'expanded-schema-tool-call',
          tool_name: 'repository.exec',
          repository_id: repositoryId,
          repository_revision: 7,
          command_id: 'verify',
          command: 'pnpm verify',
          cwd: '/workspace',
          timeout_ms: 120_000,
          status: 'running',
          disposition: null,
          owner_id: 'expanded-owner',
          lease_id: 'expanded-lease',
          lease_expires_at: '2026-09-01T00:05:00.000Z',
          started_at: '2026-09-01T00:00:00.000Z',
          completed_at: null,
        })
        .execute();
      await db
        .insertInto('repository_workspace_verification')
        .values({
          repository_id: repositoryId,
          workspace_cwd: '/workspace',
          mutation_epoch: 9,
          lease_owner_id: null,
          lease_id: null,
          lease_expires_at: null,
          observation_pending: 1,
          receipt_state_sha256: null,
          receipt_command: null,
          receipt_created_at: null,
          receipt_result_session_id: null,
          receipt_result_turn_id: null,
          receipt_result_thread_id: null,
          receipt_result_tool_call_id: null,
          receipt_result_event_id: null,
        })
        .execute();
      await sql`DELETE FROM kysely_migration WHERE name = ${COMMAND_EXECUTION_REPAIR}`.execute(db);

      await expect(migrateSqliteToLatest(db)).resolves.toBeUndefined();

      const columns = await sql<{ name: string }>`PRAGMA table_info(command_execution)`.execute(db);
      expect(columns.rows.map(column => column.name)).toEqual(
        expect.arrayContaining(['owner_id', 'lease_id', 'lease_expires_at']),
      );
      const commandRows = await db
        .selectFrom('command_execution')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('turn_id', '=', turnId)
        .execute();
      expect(commandRows).toEqual([
        {
          session_id: sessionId,
          turn_id: turnId,
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'expanded-schema-tool-call',
          tool_name: 'repository.exec',
          repository_id: repositoryId,
          repository_revision: 7,
          command_id: 'verify',
          command: 'pnpm verify',
          cwd: '/workspace',
          timeout_ms: 120_000,
          status: 'running',
          disposition: null,
          owner_id: 'expanded-owner',
          lease_id: 'expanded-lease',
          lease_expires_at: '2026-09-01T00:05:00.000Z',
          started_at: '2026-09-01T00:00:00.000Z',
          completed_at: null,
        },
      ]);
      const workspaceRows = await db
        .selectFrom('repository_workspace_verification')
        .selectAll()
        .where('repository_id', '=', repositoryId)
        .where('workspace_cwd', '=', '/workspace')
        .execute();
      expect(workspaceRows).toEqual([
        {
          repository_id: repositoryId,
          workspace_cwd: '/workspace',
          mutation_epoch: 9,
          lease_owner_id: null,
          lease_id: null,
          lease_expires_at: null,
          observation_pending: 1,
          receipt_state_sha256: null,
          receipt_command: null,
          receipt_created_at: null,
          receipt_result_session_id: null,
          receipt_result_turn_id: null,
          receipt_result_thread_id: null,
          receipt_result_tool_call_id: null,
          receipt_result_event_id: null,
        },
      ]);
      const repairRows = await sql<{ count: number }>`
        SELECT count(*) AS count FROM kysely_migration WHERE name = ${COMMAND_EXECUTION_REPAIR}
      `.execute(db);
      expect(repairRows.rows).toEqual([{ count: 1 }]);
    } finally {
      await db.destroy();
    }
  });

  it('recreates missing command-execution tables when the historical migration row exists', async () => {
    const db = createSqliteDb(':memory:');

    try {
      await migrateSqliteToLatest(db);
      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      try {
        await db.transaction().execute(async trx => {
          await sql`DROP TABLE repository_workspace_verification`.execute(trx);
          await sql`DROP INDEX command_execution_running_idx`.execute(trx);
          await sql`DROP TABLE command_execution`.execute(trx);
          await sql`DELETE FROM kysely_migration WHERE name = ${COMMAND_EXECUTION_REPAIR}`.execute(trx);
        });
      } finally {
        await sql`PRAGMA foreign_keys = ON`.execute(db);
      }

      await expect(migrateSqliteToLatest(db)).resolves.toBeUndefined();

      const tables = await sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('command_execution', 'repository_workspace_verification')
        ORDER BY name
      `.execute(db);
      expect(tables.rows).toEqual([{ name: 'command_execution' }, { name: 'repository_workspace_verification' }]);
    } finally {
      await db.destroy();
    }
  });
});
