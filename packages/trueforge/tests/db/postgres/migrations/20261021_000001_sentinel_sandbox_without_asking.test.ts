import { sql } from 'kysely';

import { migrateTo, migrateToLatest } from '../../../../src/db/migratePostgres';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;
const PREVIOUS_MIGRATION = '20261020_000001_sentinel_maps_without_asking';

describePg('Postgres sandbox switch migration', () => {
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

  async function sandboxColumn(): Promise<{ column_default: string | null; is_nullable: string }[]> {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    const { rows } = await sql<{ column_default: string | null; is_nullable: string }>`
      SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'sentinel_user_settings'
        AND column_name = 'sandbox_without_asking'
    `.execute(env.db);
    return rows;
  }

  it('adds a not-null column that defaults to true, removes it on rollback, and can be applied again', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    expect(await sandboxColumn()).toEqual([]);
    await migrateToLatest(env.db);
    const added = await sandboxColumn();
    expect(added).toHaveLength(1);
    expect(added[0]?.is_nullable).toBe('NO');
    expect(added[0]?.column_default).toMatch(/^true/);
    await migrateTo(env.db, PREVIOUS_MIGRATION);
    expect(await sandboxColumn()).toEqual([]);
    await migrateToLatest(env.db);
    expect(await sandboxColumn()).toHaveLength(1);
    await migrateTo(env.db, PREVIOUS_MIGRATION);
  });
});
