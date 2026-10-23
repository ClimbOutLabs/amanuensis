import { sql } from 'kysely';

import { BriefItemCompletionStore } from '../../../../src/db/briefItemCompletionStore';
import { runBriefItemCompletionStoreContractSuite } from '../../briefItemCompletionStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('BriefItemCompletionStore on Postgres (IBriefItemCompletionStore contract)', () => {
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
      await sql`TRUNCATE TABLE brief_item_completion`.execute(env.db);
    }
  });

  runBriefItemCompletionStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new BriefItemCompletionStore(env.db);
  });
});
