import { SqliteSentinelSettingsStore } from '../../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { runSentinelSettingsStoreContractSuite } from '../../sentinelSettingsStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteSentinelSettingsStore (ISentinelSettingsStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runSentinelSettingsStoreContractSuite(() => new SqliteSentinelSettingsStore(env.db));
});
