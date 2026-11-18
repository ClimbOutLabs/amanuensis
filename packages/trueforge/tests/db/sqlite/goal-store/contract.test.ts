import { GoalStore } from '../../../../src/db/goalStore';
import { runGoalStoreContractSuite } from '../../goalStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('GoalStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runGoalStoreContractSuite(() => new GoalStore(env.db));
});
