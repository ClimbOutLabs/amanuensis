import { sql } from 'kysely';

import { SqliteRepositoryStore } from '../../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { jsonbBind, nowIso } from '../../../../src/db/sqlite/sqlExpressions';
import { runRepositoryStoreContractSuite } from '../../repositoryStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteRepositoryStore', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runRepositoryStoreContractSuite(
    () => new SqliteRepositoryStore(env.db),
    async ({ tenant_id, created_by, session_id }) => {
      const timestamp = nowIso();
      await env.db
        .insertInto('session')
        .values({
          tenant_id,
          session_id,
          created_by_subject: jsonbBind({
            subject_id: created_by,
            subject_type: 'user',
            subject_display_name: created_by,
          }),
          source: null,
          agent_id: null,
          agent_name: null,
          agent_spec: jsonbBind({ model: { name: 'local/test' }, instructions: 'test' }),
          title: null,
          folder_id: null,
          last_turn_id: null,
          approval_grants: jsonbBind([]),
          custom: null,
          metadata: jsonbBind({}),
          external_id: null,
          metrics: jsonbBind({ total_duration_ms: 0, total_turns: 0 }),
          created_at: timestamp,
          updated_at: timestamp,
          last_activity_timestamp_ms: Date.now(),
        })
        .execute();
    },
    async ({ session_id, turn_id, thread_id, tool_call_id, event_id, parts }) => {
      const createdAt = nowIso();
      if (parts !== 'context') {
        await env.db
          .insertInto('session_event')
          .values({
            session_id,
            turn_id,
            event_id,
            event: jsonbBind({
              id: event_id,
              type: 'tool.response.v2',
              created_at: createdAt,
              thread_id,
              tool_call_id,
              disposition: 'executed_ok',
            }),
            created_at: createdAt,
          })
          .execute();
      }
      if (parts !== 'event') {
        await env.db
          .insertInto('thread_context_log')
          .values({
            session_id,
            turn_id,
            thread_id,
            body: jsonbBind({ role: 'tool', tool_call_id, content: 'verification passed' }),
            created_at: createdAt,
          })
          .execute();
      }
    },
  );

  it('has the additive repository/session/command schema', async () => {
    const rows = await sql<{ table_name: string; column_name: string }>`
      SELECT m.name AS table_name, p.name AS column_name
      FROM sqlite_master AS m
      JOIN pragma_table_info(m.name) AS p
      WHERE m.name IN ('repository', 'session', 'repository_verify_command', 'repository_verify_command_proposal')
    `.execute(env.db);
    const columns = new Map<string, string[]>();
    for (const row of rows.rows) {
      const tableColumns = columns.get(row.table_name) ?? [];
      tableColumns.push(row.column_name);
      columns.set(row.table_name, tableColumns);
    }
    expect(columns.get('repository')).toEqual(
      expect.arrayContaining(['id', 'tenant_id', 'created_by', 'name', 'clone_url', 'default_branch', 'revision']),
    );
    expect(columns.get('session')).toEqual(expect.arrayContaining(['repository_id', 'workspace_cwd']));
    expect(columns.get('repository_verify_command')).toEqual(
      expect.arrayContaining(['repository_id', 'command_id', 'purpose', 'command', 'timeout_ms']),
    );
    expect(columns.get('repository_verify_command_proposal')).toEqual(
      expect.arrayContaining([
        'id',
        'repository_id',
        'purpose',
        'command',
        'source_kind',
        'source_path',
        'source_fingerprint',
      ]),
    );
  });
});
