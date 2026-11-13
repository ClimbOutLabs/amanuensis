import { DeliveryStore } from '../../../../src/db/deliveryStore';
import { runDeliveryStoreContractSuite } from '../../deliveryStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('DeliveryStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runDeliveryStoreContractSuite(() => new DeliveryStore(env.db));
});
