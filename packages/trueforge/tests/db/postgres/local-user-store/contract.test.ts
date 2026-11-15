import { sql } from 'kysely';

import { PostgresLocalUserStore } from '../../../../src/db/postgres/local-user-store/PostgresLocalUserStore';
import { runLocalUserStoreContractSuite } from '../../localUserStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('LocalUserStore on Postgres (contract)', () => {
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
      await sql`TRUNCATE TABLE local_user CASCADE`.execute(env.db);
    }
  });

  runLocalUserStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PostgresLocalUserStore(env.db);
  });
});
