import { HTTPException } from 'hono/http-exception';
import { makeAgentSpec } from '../../../../trueforge-core/tests/agent-session/testHelpers';
import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import { SearchOwnChatsResponseSchema } from '../../../src/schemas/chatSearch';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const SEARCH_PATH = '/api/v1/user/chat-search';
const SETTINGS_PATH = '/api/v1/user/settings/sentinel';

/** Identifies the caller by `x-test-user`; a request without it is unauthenticated. */
const headerAuthenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    const context: RequestContext = {
      tenant_id: 'default',
      subject: { id: user, type: 'user', display_name: user },
      roles: [],
      user_credential: null,
    };
    return Promise.resolve(context);
  },
};

function asUser(user: string, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', user);
  if (init?.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return { ...init, headers };
}

describe('chat list search route', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer({ authenticator: headerAuthenticator });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  async function seedChat(input: {
    owner: string;
    sessionId: string;
    title: string;
    text: string;
    persona: string | null;
  }) {
    const store = server.sessionStore();
    await store.createSession({
      tenant_id: 'default',
      session_id: input.sessionId,
      created_by_subject: { subject_id: input.owner, subject_type: 'user', subject_display_name: input.owner },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
    await store.updateSession({
      tenant_id: 'default',
      session_id: input.sessionId,
      agent: undefined,
      title: input.title,
      metadata: undefined,
    });
    await store.indexChatMessages({
      tenant_id: 'default',
      session_id: input.sessionId,
      turn_id: 'turn-1',
      persona_id: input.persona,
      documents: [
        { message_id: 'user', role: 'user', text: input.text, created_at: new Date('2026-10-01T10:00:00.000Z') },
      ],
    });
  }

  async function search(user: string, query: string) {
    const response = await server.request(`${SEARCH_PATH}?query=${encodeURIComponent(query)}`, asUser(user));
    expect(response.status).toBe(200);
    return SearchOwnChatsResponseSchema.parse(await response.json()).data;
  }

  async function setSwitch(user: string, enabled: boolean) {
    const response = await server.request(
      SETTINGS_PATH,
      asUser(user, { method: 'PATCH', body: JSON.stringify({ chat_search_enabled: enabled }) }),
    );
    expect(response.status).toBe(200);
  }

  it('requires authentication', async () => {
    expect((await server.request(`${SEARCH_PATH}?query=ferry`)).status).toBe(401);
  });

  it('refuses a blank search with a plain message', async () => {
    const response = await server.request(`${SEARCH_PATH}?query=%20%20`, asUser('ada'));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('Type a word to search for.');
  });

  it('returns nothing, and says search is off, while the switch is off', async () => {
    await seedChat({
      owner: 'ada',
      sessionId: 'ada-off',
      title: 'Plans',
      text: 'the ferry leaves at nine',
      persona: null,
    });
    expect(await search('ada', 'ferry')).toEqual({ search_enabled: false, hits: [] });
  });

  it('finds the person own chats under every persona, with a snippet, and never another person chats', async () => {
    await setSwitch('bea', true);
    await seedChat({
      owner: 'bea',
      sessionId: 'bea-main',
      title: 'Trip',
      text: 'the ferry leaves at nine',
      persona: null,
    });
    await seedChat({
      owner: 'bea',
      sessionId: 'bea-work',
      title: 'Work',
      text: 'book the ferry for the offsite',
      persona: 'work-persona',
    });
    await seedChat({ owner: 'cal', sessionId: 'cal-chat', title: 'Cal', text: 'cal takes the ferry', persona: null });

    const result = await search('bea', 'ferry');
    expect(result.search_enabled).toBe(true);
    expect(result.hits.map(hit => hit.session_id).sort()).toEqual(['bea-main', 'bea-work']);
    expect(result.hits.find(hit => hit.session_id === 'bea-work')).toMatchObject({
      title: 'Work',
      snippet: 'book the ferry for the offsite',
      matched_at: '2026-10-01T10:00:00.000Z',
    });
  });
});
