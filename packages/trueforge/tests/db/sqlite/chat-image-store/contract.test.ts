import { makeAgentSpec } from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import { SqliteChatImageStore } from '../../../../src/db/sqlite/chat-image-store/SqliteChatImageStore';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { runChatImageStoreContractSuite } from '../../chatImageStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteChatImageStore (IChatImageStore contract)', () => {
  let env: SqliteTestDatabase;
  let sessions: SqliteSessionStore;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    sessions = new SqliteSessionStore(env.db);
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

  runChatImageStoreContractSuite(() => ({
    store: new SqliteChatImageStore(env.db),
    deleteSession: sessionId => sessions.deleteSession({ tenant_id: 'default', session_id: sessionId }),
  }));
});
