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

  runTurnArtifactStoreContractSuite(() => new SqliteTurnArtifactStore(env.db));
});
