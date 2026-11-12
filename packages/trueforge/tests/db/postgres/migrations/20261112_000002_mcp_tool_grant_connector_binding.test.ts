/**
 * `20261112_000002_mcp_tool_grant_connector_binding` binds each standing grant to its connector's setup instead
 * of its host. A grant recorded for a host can never match a setup, so it is removed and the next call asks again.
 */
import { sql } from 'kysely';

import { migrateTo } from '../../../../src/db/migratePostgres';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;
const PREVIOUS_MIGRATION = '20261111_000001_noticing';
const THIS_MIGRATION = '20261112_000002_mcp_tool_grant_connector_binding';

describePg('Postgres mcp tool grant connector binding migration', () => {
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

  it('removes grants bound to a host and swaps the host column for the setup binding, both ways', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    const { db } = env;
    const columns = async () =>
      (
        await sql<{ column_name: string }>`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'mcp_tool_grant' AND column_name IN ('mcp_server_host', 'connector_binding')
        `.execute(db)
      ).rows.map(row => row.column_name);
    await sql`
      INSERT INTO mcp_tool_grant (tenant_id, created_by, mcp_server_name, tool_name, mcp_server_host, created_at)
      VALUES ('tenant-1', 'alice', 'notes', 'lookup_note', 'notes.example.com', now())
    `.execute(db);

    await migrateTo(db, THIS_MIGRATION);

    expect((await sql`SELECT tool_name FROM mcp_tool_grant`.execute(db)).rows).toEqual([]);
    expect(await columns()).toEqual(['connector_binding']);

    await sql`
      INSERT INTO mcp_tool_grant (tenant_id, created_by, mcp_server_name, tool_name, connector_binding, created_at)
      VALUES ('tenant-1', 'alice', 'notes', 'lookup_note', 'setup-of-notes', now())
    `.execute(db);
    await migrateTo(db, PREVIOUS_MIGRATION);

    expect((await sql`SELECT tool_name FROM mcp_tool_grant`.execute(db)).rows).toEqual([]);
    expect(await columns()).toEqual(['mcp_server_host']);
  });
});
