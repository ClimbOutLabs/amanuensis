import { BriefItemCompletionStore } from '../../../../src/db/briefItemCompletionStore';
import { runBriefItemCompletionStoreContractSuite } from '../../briefItemCompletionStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('BriefItemCompletionStore on SQLite (IBriefItemCompletionStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runBriefItemCompletionStoreContractSuite(() => new BriefItemCompletionStore(env.db));
});
