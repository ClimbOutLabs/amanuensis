import { makeAgentSpec } from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

const TENANT = 'default';
const SESSION = 'chat-fingerprints';

const FINGERPRINTS = {
  complete: true,
  has_text: true,
  secret: false,
  entries: [{ kind: 'name' as const, length: 2, digest: '0123456789abcdef0123456789abcdef' }],
};

describe('SqliteSessionStore private fingerprints', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  async function seedChat(store: SqliteSessionStore): Promise<void> {
    await store.createSession({
      tenant_id: TENANT,
      session_id: SESSION,
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
  }

  it('keeps the saved fingerprints with the chat, and deleting the chat deletes them', async () => {
    const store = new SqliteSessionStore(env.db);
    await seedChat(store);
    expect((await store.getSession({ tenant_id: TENANT, session_id: SESSION }))?.private_fingerprints).toBeNull();

    await store.setPrivateFingerprints({ session_id: SESSION, fingerprints: FINGERPRINTS });
    expect((await store.getSession({ tenant_id: TENANT, session_id: SESSION }))?.private_fingerprints).toEqual(
      FINGERPRINTS,
    );

    await store.deleteSession({ tenant_id: TENANT, session_id: SESSION });
    expect(await store.getSession({ tenant_id: TENANT, session_id: SESSION })).toBeUndefined();
    const rows = await env.db.selectFrom('session').select('session_id').where('session_id', '=', SESSION).execute();
    expect(rows).toEqual([]);
  });

  it('does not change the chat when it is saved for a chat that does not exist', async () => {
    const store = new SqliteSessionStore(env.db);
    await store.setPrivateFingerprints({ session_id: 'missing-chat', fingerprints: FINGERPRINTS });
    expect(await store.getSession({ tenant_id: TENANT, session_id: 'missing-chat' })).toBeUndefined();
  });
});
