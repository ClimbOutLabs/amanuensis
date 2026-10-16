import { sql } from 'kysely';

import { PostgresTokenFactoryUsageStore } from '../../../../src/db/postgres/token-factory-usage-store/PostgresTokenFactoryUsageStore';
import { runTokenFactoryUsageStoreContractSuite } from '../../tokenFactoryUsageStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresTokenFactoryUsageStore (ITokenFactoryUsageStore contract)', () => {
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
      await sql`TRUNCATE TABLE token_factory_usage`.execute(env.db);
    }
  });

  runTokenFactoryUsageStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PostgresTokenFactoryUsageStore(env.db);
  });
});
