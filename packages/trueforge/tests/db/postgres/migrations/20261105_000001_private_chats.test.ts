import { sql } from 'kysely';

import { migrateTo, migrateToLatest } from '../../../../src/db/migratePostgres';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;
const PREVIOUS_MIGRATION = '20261102_000004_delivery';

describePg('Postgres private chats migration', () => {
  let env: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    env = await createPostgresTestDatabase(PREVIOUS_MIGRATION);
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  function requireEnv(): PostgresTestDatabase {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return env;
  }

  async function insertSession(input: {
    sessionId: string;
    columns?: { is_incognito: boolean; private_expires_at: string | null };
  }): Promise<void> {
    const { db } = requireEnv();
    if (input.columns === undefined) {
      await sql`
        INSERT INTO session (
          tenant_id, session_id, created_by_subject, agent_spec, approval_grants,
          last_activity_timestamp_ms, created_at, updated_at
        )
        VALUES (
          't1', ${input.sessionId}, '{"subject_id":"alice","subject_type":"user"}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          0, now(), now()
        )
      `.execute(db);
      return;
    }
    await sql`
      INSERT INTO session (
        tenant_id, session_id, created_by_subject, agent_spec, approval_grants,
        last_activity_timestamp_ms, created_at, updated_at, is_incognito, private_expires_at
      )
      VALUES (
        't1', ${input.sessionId}, '{"subject_id":"alice","subject_type":"user"}'::jsonb, '{}'::jsonb, '[]'::jsonb,
        0, now(), now(), ${input.columns.is_incognito}, ${input.columns.private_expires_at}::timestamptz
      )
    `.execute(db);
  }

  async function sessionColumns(): Promise<string[]> {
    const { rows } = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'session'
    `.execute(requireEnv().db);
    return rows.map(row => row.column_name);
  }

  async function usageTableExists(): Promise<boolean> {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'deleted_chat_model_usage'
    `.execute(requireEnv().db);
    return rows.length === 1;
  }

  it('keeps existing chats normal, holds the expiry rule, and rolls back', async () => {
    const { db } = requireEnv();
    await insertSession({ sessionId: 'older-chat' });

    await migrateToLatest(db);
    expect(await sessionColumns()).toEqual(expect.arrayContaining(['is_incognito', 'private_expires_at']));
    expect(await usageTableExists()).toBe(true);
    const { rows } = await sql<{ is_incognito: boolean; private_expires_at: Date | null }>`
      SELECT is_incognito, private_expires_at FROM session WHERE session_id = 'older-chat'
    `.execute(db);
    expect(rows).toEqual([{ is_incognito: false, private_expires_at: null }]);

    await insertSession({
      sessionId: 'private-chat',
      columns: { is_incognito: true, private_expires_at: '2026-11-06T00:00:00.000Z' },
    });
    await expect(
      insertSession({ sessionId: 'no-expiry', columns: { is_incognito: true, private_expires_at: null } }),
    ).rejects.toThrow();
    await expect(
      insertSession({
        sessionId: 'expiry-only',
        columns: { is_incognito: false, private_expires_at: '2026-11-06T00:00:00.000Z' },
      }),
    ).rejects.toThrow();

    await sql`DELETE FROM session WHERE session_id = 'private-chat'`.execute(db);
    await migrateTo(db, PREVIOUS_MIGRATION);
    expect(await sessionColumns()).not.toContain('is_incognito');
    expect(await usageTableExists()).toBe(false);
    await migrateToLatest(db);
    expect(await sessionColumns()).toContain('private_expires_at');
  });
});
