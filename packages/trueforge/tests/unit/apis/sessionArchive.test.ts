import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { createSessionFolderAssignmentsRouter } from '../../../src/apis/sessionFolders';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { keepOwnChatHits, searchPastChats } from '../../../src/runtime/pastChats';

describe('archive chats', () => {
  let db: ReturnType<typeof createSqliteDb>;
  let store: SqliteSessionStore;
  let app: OpenAPIHono;
  const owner = STANDALONE_REQUEST_CONTEXT.subject.id;
  const tenant = 'default';
  const spec = AgentSpecSchema.parse({ model: { name: 'local/demo' } });

  async function seed(input: { sessionId: string; creator: string; incognito: boolean }) {
    await store.createSession({
      tenant_id: tenant,
      session_id: input.sessionId,
      created_by_subject: { subject_id: input.creator, subject_type: 'user', subject_display_name: 'Demo person' },
      agent: { type: 'inline', spec },
      metadata: { agent_details: 'true' },
      custom: null,
      external_id: null,
      source: null,
      is_incognito: input.incognito,
      private_expires_at: input.incognito ? new Date(Date.now() + 60_000) : null,
    });
  }

  function setArchive(input: { sessionId: string; archived: boolean }) {
    return app.request(`/${input.sessionId}/archive`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: input.archived }),
    });
  }

  beforeEach(async () => {
    db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    store = new SqliteSessionStore(db);
    app = new OpenAPIHono();
    app.route(
      '/',
      createSessionFolderAssignmentsRouter({
        sessionStore: store,
        resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      }),
    );
    await seed({ sessionId: 'chat-1', creator: owner, incognito: false });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('persists archive and restore while preserving metadata, folder and message search', async () => {
    await store.createSessionFolder({ tenant_id: tenant, folder_id: 'folder-1', created_by: owner, name: 'Projects' });
    await store.setSessionFolder({ tenant_id: tenant, session_id: 'chat-1', created_by: owner, folder_id: 'folder-1' });
    await store.indexChatMessages({
      tenant_id: tenant,
      session_id: 'chat-1',
      turn_id: 'turn-1',
      persona_id: null,
      documents: [
        { message_id: 'message-1', role: 'user', text: 'Find the lighthouse project', created_at: new Date() },
      ],
    });
    expect((await setArchive({ sessionId: 'chat-1', archived: true })).status).toBe(200);
    expect((await setArchive({ sessionId: 'chat-1', archived: true })).status).toBe(200);
    const reopened = new SqliteSessionStore(db);
    const record = await reopened.getSession({ tenant_id: tenant, session_id: 'chat-1' });
    expect(record?.metadata).toEqual({ agent_details: 'true', archived: 'true' });
    expect(record?.folder_id).toBe('folder-1');
    const hits = await searchPastChats({
      sessionStore: reopened,
      tenantId: tenant,
      userRef: owner,
      currentSessionId: 'another-chat',
      personaIds: [],
      input: { query: 'lighthouse' },
    });
    expect(hits.map(hit => hit.session_id)).toEqual(['chat-1']);
    const userHits = await keepOwnChatHits({ sessionStore: reopened, tenantId: tenant, userRef: owner, hits });
    expect(userHits.map(hit => hit.session_id)).toEqual(['chat-1']);
    expect((await setArchive({ sessionId: 'chat-1', archived: false })).status).toBe(200);
    expect((await reopened.getSession({ tenant_id: tenant, session_id: 'chat-1' }))?.metadata).toEqual({
      agent_details: 'true',
      archived: 'false',
    });
  });

  it('refuses other owners, incognito chats, missing chats and invalid requests', async () => {
    await seed({ sessionId: 'other-chat', creator: 'other-person', incognito: false });
    await seed({ sessionId: 'private-chat', creator: owner, incognito: true });
    expect((await setArchive({ sessionId: 'other-chat', archived: true })).status).toBe(403);
    expect((await setArchive({ sessionId: 'private-chat', archived: true })).status).toBe(422);
    expect((await setArchive({ sessionId: 'missing-chat', archived: true })).status).toBe(404);
    expect(
      (
        await app.request('/chat-1/archive', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{"archived":"true"}',
        })
      ).status,
    ).toBe(400);
    expect((await store.getSession({ tenant_id: tenant, session_id: 'other-chat' }))?.metadata).toEqual({
      agent_details: 'true',
    });
  });
});
