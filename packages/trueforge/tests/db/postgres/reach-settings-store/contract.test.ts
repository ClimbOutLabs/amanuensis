import { sql } from 'kysely';

import { ReachSettingsStore } from '../../../../src/db/reachSettingsStore';
import { runReachSettingsStoreContractSuite } from '../../reachSettingsStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('ReachSettingsStore on Postgres (contract)', () => {
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

  beforeEach(async () => {
    if (env !== undefined) {
      await sql`TRUNCATE TABLE reach_settings`.execute(env.db);
    }
  });

  runReachSettingsStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new ReachSettingsStore(env.db);
  });
});
