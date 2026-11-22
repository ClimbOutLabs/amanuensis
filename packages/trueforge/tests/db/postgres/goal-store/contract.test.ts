import { sql } from 'kysely';

import { GoalStore } from '../../../../src/db/goalStore';
import { runGoalStoreContractSuite } from '../../goalStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('GoalStore on Postgres (contract)', () => {
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
      await sql`TRUNCATE TABLE goal, goal_step, goal_evidence, goal_event, goal_cycle, goal_action, goal_claim, goal_wakeup, goal_fencing_counter CASCADE`.execute(
        env.db,
      );
    }
  });

  runGoalStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new GoalStore(env.db);
  });
});
