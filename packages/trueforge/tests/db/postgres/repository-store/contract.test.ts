import { sql } from 'kysely';

import { PostgresRepositoryStore } from '../../../../src/db/postgres/repository-store/PostgresRepositoryStore';
import { json } from '../../../../src/db/postgres/sqlExpressions';
import { runRepositoryStoreContractSuite } from '../../repositoryStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresRepositoryStore', () => {
  let env: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    env = await createPostgresTestDatabase();
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  runRepositoryStoreContractSuite(
    () => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      return new PostgresRepositoryStore(env.db);
    },
    async ({ tenant_id, created_by, session_id }) => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      await env.db
        .insertInto('session')
        .values({
          tenant_id,
          session_id,
          created_by_subject: json({ subject_id: created_by, subject_type: 'user', subject_display_name: created_by }),
          source: null,
          agent_id: null,
          agent_name: null,
          agent_spec: sql`'{"model":{"name":"local/test"},"instructions":"test"}'::jsonb`,
          title: null,
          folder_id: null,
          last_turn_id: null,
          approval_grants: sql`'[]'::jsonb`,
          task_checklist: sql`'{"revision":0,"items":[]}'::jsonb`,
          custom: null,
          metadata: sql`'{}'::jsonb`,
          external_id: null,
          metrics: sql`'{"total_duration_ms":0,"total_turns":0}'::jsonb`,
          created_at: new Date(),
          updated_at: new Date(),
          last_activity_timestamp_ms: Date.now(),
        })
        .execute();
    },
    async ({ session_id, turn_id, thread_id, tool_call_id, event_id, parts }) => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      const createdAt = new Date();
      if (parts !== 'context') {
        await env.db
          .insertInto('session_event')
          .values({
            session_id,
            turn_id,
            event_id,
            event: sql`${JSON.stringify({
              id: event_id,
              type: 'tool.response.v2',
              created_at: createdAt.toISOString(),
              thread_id,
              tool_call_id,
              disposition: 'executed_ok',
            })}::jsonb`,
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
            body: sql`${JSON.stringify({ role: 'tool', tool_call_id, content: 'verification passed' })}::jsonb`,
            created_at: createdAt,
          })
          .execute();
      }
    },
  );

  it('has the additive repository/session/command schema', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    const rows = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('repository', 'session', 'repository_verify_command', 'repository_verify_command_proposal')
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
