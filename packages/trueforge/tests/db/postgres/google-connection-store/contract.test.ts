import { sql } from 'kysely';

import { PostgresGoogleConnectionStore } from '../../../../src/db/postgres/google-connection-store/PostgresGoogleConnectionStore';
import { runGoogleConnectionStoreContractSuite } from '../../googleConnectionStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresGoogleConnectionStore (IGoogleConnectionStore contract)', () => {
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
      await sql`TRUNCATE TABLE google_connection, google_oauth_pending`.execute(env.db);
    }
  });

  runGoogleConnectionStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PostgresGoogleConnectionStore(env.db);
  });
});
