import { sql } from 'kysely';

import { SqliteTurnArtifactStore } from '../../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import { runTurnArtifactStoreContractSuite } from '../../turnArtifactStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteTurnArtifactStore (ITurnArtifactStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runTurnArtifactStoreContractSuite({
    getStore: () => new SqliteTurnArtifactStore(env.db),
    backdate: async identity => {
      await sql`UPDATE turn_artifact SET created_at = ${identity.created_at}
        WHERE tenant_id = ${identity.tenant_id} AND session_id = ${identity.session_id}
          AND turn_id = ${identity.turn_id} AND path = ${identity.path}`.execute(env.db);
    },
  });
});
