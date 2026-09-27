import { SqliteGlobalSettingsStore } from '../../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { runGlobalSettingsStoreContractSuite } from '../../globalSettingsStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteGlobalSettingsStore (IGlobalSettingsStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runGlobalSettingsStoreContractSuite(() => new SqliteGlobalSettingsStore(env.db));
});
