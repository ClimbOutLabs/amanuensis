import { SqliteTokenFactoryUsageStore } from '../../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import { runTokenFactoryUsageStoreContractSuite } from '../../tokenFactoryUsageStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteTokenFactoryUsageStore (ITokenFactoryUsageStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runTokenFactoryUsageStoreContractSuite(() => new SqliteTokenFactoryUsageStore(env.db));
});
