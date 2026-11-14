import { sql } from 'kysely';

import { PostgresGlobalSettingsStore } from '../../../../src/db/postgres/global-settings-store/PostgresGlobalSettingsStore';
import { runSecretVaultContractSuite } from '../../secretVaultContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('SecretVault on Postgres', () => {
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
      await sql`TRUNCATE TABLE global_settings`.execute(env.db);
    }
  });

  runSecretVaultContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PostgresGlobalSettingsStore(env.db);
  });
});
