/**
 * `20261020_000002_mcp_tool_grant_server_host` binds each standing grant to its connector host. A grant
 * recorded before the column existed has no binding, so the upgrade removes it rather than trusting it.
 */
import { sql } from 'kysely';

import { migrateToLatest } from '../../../../src/db/migratePostgres';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;
const PREVIOUS_MIGRATION = '20261020_000001_sentinel_maps_without_asking';

describePg('Postgres mcp tool grant server host migration', () => {
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

  it('removes grants recorded before the host binding and adds the column', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    await sql`
      INSERT INTO mcp_tool_grant (tenant_id, created_by, mcp_server_name, tool_name, created_at)
      VALUES ('tenant-1', 'alice', 'notes', 'lookup_note', now())
    `.execute(env.db);

    await migrateToLatest(env.db);

    const remaining = await sql<{ tool_name: string }>`SELECT tool_name FROM mcp_tool_grant`.execute(env.db);
    expect(remaining.rows).toEqual([]);
    const column = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'mcp_tool_grant' AND column_name = 'mcp_server_host'
    `.execute(env.db);
    expect(column.rows).toHaveLength(1);
  });
});
