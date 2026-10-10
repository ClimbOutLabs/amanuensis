import { sql } from 'kysely';

import { PostgresSentinelSettingsStore } from '../../../../src/db/postgres/sentinel-settings-store/PostgresSentinelSettingsStore';
import { runSentinelSettingsStoreContractSuite } from '../../sentinelSettingsStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresSentinelSettingsStore (ISentinelSettingsStore contract)', () => {
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
      await sql`TRUNCATE TABLE sentinel_user_settings`.execute(env.db);
    }
  });

  runSentinelSettingsStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PostgresSentinelSettingsStore(env.db);
  });
});
