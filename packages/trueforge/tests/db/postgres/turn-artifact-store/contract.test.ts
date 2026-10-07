import { sql } from 'kysely';
import { PostgresTurnArtifactStore } from '../../../../src/db/postgres/turn-artifact-store/PostgresTurnArtifactStore';
import { runTurnArtifactStoreContractSuite } from '../../turnArtifactStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresTurnArtifactStore (ITurnArtifactStore contract)', () => {
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
      await sql`TRUNCATE TABLE turn_artifact, artifact_blob`.execute(env.db);
    }
  });

  runTurnArtifactStoreContractSuite({
    getStore: () => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      return new PostgresTurnArtifactStore(env.db);
    },
    backdate: async identity => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      await sql`UPDATE turn_artifact SET created_at = ${identity.created_at}::timestamptz
        WHERE tenant_id = ${identity.tenant_id} AND session_id = ${identity.session_id}
          AND turn_id = ${identity.turn_id} AND path = ${identity.path}`.execute(env.db);
    },
  });
});
