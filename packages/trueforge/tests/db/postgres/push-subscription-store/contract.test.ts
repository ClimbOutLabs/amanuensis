import { sql } from 'kysely';

import { PushSubscriptionStore } from '../../../../src/db/pushSubscriptionStore';
import { runPushSubscriptionStoreContractSuite } from '../../pushSubscriptionStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PushSubscriptionStore on Postgres (contract)', () => {
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
      await sql`TRUNCATE TABLE push_subscription CASCADE`.execute(env.db);
    }
  });

  runPushSubscriptionStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PushSubscriptionStore(env.db);
  });
});
