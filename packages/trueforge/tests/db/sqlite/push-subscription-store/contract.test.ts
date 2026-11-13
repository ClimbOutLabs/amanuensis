import { PushSubscriptionStore } from '../../../../src/db/pushSubscriptionStore';
import { runPushSubscriptionStoreContractSuite } from '../../pushSubscriptionStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('PushSubscriptionStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runPushSubscriptionStoreContractSuite(() => new PushSubscriptionStore(env.db));
});
