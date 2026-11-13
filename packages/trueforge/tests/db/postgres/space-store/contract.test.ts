import { sql } from 'kysely';
import { PostgresSpaceStore } from '../../../../src/db/postgres/space-store/PostgresSpaceStore';
import { runSpaceStoreContractSuite } from '../../spaceStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresSpaceStore (ISpaceStore contract)', () => {
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
      await sql`TRUNCATE TABLE space, space_aggregate, space_revision, space_folder, space_folder_assignment`.execute(
        env.db,
      );
    }
  });

  runSpaceStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PostgresSpaceStore(env.db);
  });
});
