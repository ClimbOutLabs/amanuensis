import { sql } from 'kysely';

import { down, up } from '../../../../src/db/postgres/migrations/20261016_000003_google_connection';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;
const PREVIOUS_MIGRATION = '20261011_000001_sentinel_search_without_asking';

describePg('Postgres Google connection migration', () => {
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

  async function googleTables(): Promise<string[]> {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'google\_%'
      ORDER BY table_name
    `.execute(env.db);
    return rows.map(row => row.table_name);
  }

  it('creates both tables, removes both when rolled back, and can be applied again', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    expect(await googleTables()).toEqual([]);
    await up(env.db);
    expect(await googleTables()).toEqual(['google_connection', 'google_oauth_pending']);
    await down(env.db);
    expect(await googleTables()).toEqual([]);
    await up(env.db);
    expect(await googleTables()).toEqual(['google_connection', 'google_oauth_pending']);
    await down(env.db);
  });
});
