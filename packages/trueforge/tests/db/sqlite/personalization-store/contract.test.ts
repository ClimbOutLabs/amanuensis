import { SqlitePersonalizationStore } from '../../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { runPersonalizationStoreContractSuite } from '../../personalizationStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqlitePersonalizationStore (IPersonalizationStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runPersonalizationStoreContractSuite(() => new SqlitePersonalizationStore(env.db));
});
