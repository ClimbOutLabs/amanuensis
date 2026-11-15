import { ReachSettingsStore } from '../../../../src/db/reachSettingsStore';
import { runReachSettingsStoreContractSuite } from '../../reachSettingsStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('ReachSettingsStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runReachSettingsStoreContractSuite(() => new ReachSettingsStore(env.db));
});
