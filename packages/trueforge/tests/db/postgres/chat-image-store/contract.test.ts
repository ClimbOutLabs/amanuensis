import { sql } from 'kysely';
import { makeAgentSpec } from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import { PostgresChatImageStore } from '../../../../src/db/postgres/chat-image-store/PostgresChatImageStore';
import { PostgresSessionStore } from '../../../../src/db/postgres/session-store/PostgresSessionStore';
import { runChatImageStoreContractSuite } from '../../chatImageStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresChatImageStore (IChatImageStore contract)', () => {
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
      await sql`TRUNCATE TABLE chat_image`.execute(env.db);
      await env.db.deleteFrom('session').where('session_id', 'in', ['s1', 's2']).execute();
      const sessions = new PostgresSessionStore(env.db);
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
    }
  });

  runChatImageStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    const sessions = new PostgresSessionStore(env.db);
    return {
      store: new PostgresChatImageStore(env.db),
      deleteSession: sessionId => sessions.deleteSession({ tenant_id: 'default', session_id: sessionId }),
    };
  });
});
