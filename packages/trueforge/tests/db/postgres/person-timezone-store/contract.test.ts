import { sql } from 'kysely';

import { PersonTimezoneStore } from '../../../../src/db/personTimezoneStore';
import { runPersonTimezoneStoreContractSuite } from '../../personTimezoneStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PersonTimezoneStore on Postgres (contract)', () => {
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
      await sql`TRUNCATE TABLE person_timezone`.execute(env.db);
    }
  });

  runPersonTimezoneStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PersonTimezoneStore(env.db);
  });
});
