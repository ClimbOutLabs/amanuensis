import { makeAgentSpec } from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import { SqlitePersonaStore } from '../../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { runPersonaStoreContractSuite } from '../../personaStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqlitePersonaStore (IPersonaStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    const sessions = new SqliteSessionStore(env.db);
    for (const sessionId of ['s1', 's2']) {
      await sessions.createSession({
        tenant_id: 'default',
        session_id: sessionId,
        created_by_subject: { subject_id: 'user-a', subject_type: 'user', subject_display_name: 'user-a' },
        external_id: null,
        source: null,
        metadata: {},
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
      });
    }
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runPersonaStoreContractSuite(() => new SqlitePersonaStore(env.db));
});
