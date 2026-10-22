import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { HTTPException } from 'hono/http-exception';
import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { BriefItemCompletionSchema, ListBriefItemCompletionsResponseSchema } from '../../../src/schemas/briefItems';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const BASE = '/api/v1/user/brief-items';

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
  return { ...init, headers };
}

function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The fixture database is shared by every test, so each test uses subjects and chats no other test uses. */
let uniqueCount = 0;
function uniqueName(prefix: string): string {
  uniqueCount += 1;
  return `${prefix}-${uniqueCount}`;
}

describe('morning brief completions route', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer({ authenticator: headerAuthenticator });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  async function createChat(user: string): Promise<string> {
    const sessionId = uniqueName(`${user}-chat`);
    await server.sessionStore().createSession({
      tenant_id: 'default',
      session_id: sessionId,
      created_by_subject: { subject_id: user, subject_type: 'user', subject_display_name: user },
      external_id: null,
      source: null,
      metadata: {},
      agent: {
        type: 'inline',
        spec: AgentSpecSchema.parse({ model: { name: 'p/m' }, instructions: 'Answer the user.' }),
      },
      custom: null,
    });
    return sessionId;
  }

  async function auditRows(user: string) {
    const page = await new SentinelAuditStore(server.db()).listForUser({
      tenant_id: 'default',
      created_by: user,
      outcome: undefined,
      limit: 100,
      page_token: undefined,
    });
    return page.entries.filter(row => row.tool_name.startsWith('brief.'));
  }

  function markDone(user: string, body: Record<string, unknown>) {
    return server.request(`${BASE}/completions`, asUser(user, jsonBody(body)));
  }

  async function listFor(user: string, query = '') {
    const response = await server.request(`${BASE}/completions${query}`, asUser(user));
    expect(response.status).toBe(200);
    return ListBriefItemCompletionsResponseSchema.parse(await response.json()).data;
  }

  const itemIn = (sessionId: string, itemKey: string) => ({
    item_key: itemKey,
    section: 'decision',
    title: 'Reply to Dana',
    session_id: sessionId,
  });

  it('requires authentication', async () => {
    expect((await server.request(`${BASE}/completions`)).status).toBe(401);
  });

  it('marks an item done, lists it, and writes a brief.item_done audit entry for the chat', async () => {
    const alice = uniqueName('alice');
    const chat = await createChat(alice);

    const response = await markDone(alice, itemIn(chat, 'bi_done_1'));
    expect(response.status).toBe(200);
    const completion = BriefItemCompletionSchema.parse(await response.json());
    expect(completion).toMatchObject({ item_key: 'bi_done_1', section: 'decision', title: 'Reply to Dana' });

    expect(await listFor(alice)).toEqual([completion]);
    const rows = await auditRows(alice);
    expect(rows.map(row => [row.tool_name, row.outcome, row.conversation_id])).toEqual([
      ['brief.item_done', 'logged', chat],
    ]);
  });

  it('marking the same item again keeps one row with the new title', async () => {
    const alice = uniqueName('alice');
    const chat = await createChat(alice);
    await markDone(alice, itemIn(chat, 'bi_again'));
    await markDone(alice, { ...itemIn(chat, 'bi_again'), title: 'Reply to Dana today' });

    expect((await listFor(alice)).map(row => row.title)).toEqual(['Reply to Dana today']);
  });

  it('answers 404 for a chat that belongs to someone else or does not exist, and writes nothing', async () => {
    const alice = uniqueName('alice');
    const bob = uniqueName('bob');
    const bobChat = await createChat(bob);

    expect((await markDone(alice, itemIn(bobChat, 'bi_foreign'))).status).toBe(404);
    expect((await markDone(alice, itemIn('no-such-chat', 'bi_missing'))).status).toBe(404);
    expect(await listFor(alice)).toEqual([]);
    expect(await auditRows(alice)).toEqual([]);
  });

  it('rejects an invalid body with 400', async () => {
    const alice = uniqueName('alice');
    const chat = await createChat(alice);
    const response = await markDone(alice, { ...itemIn(chat, 'bi_bad'), section: 'someday' });
    expect(response.status).toBe(400);
  });

  it('undo removes the item for its owner, returns 204, and audits brief.item_undone once', async () => {
    const alice = uniqueName('alice');
    const chat = await createChat(alice);
    await markDone(alice, itemIn(chat, 'bi_undo'));

    const undo = await server.request(`${BASE}/completions/bi_undo`, asUser(alice, { method: 'DELETE' }));
    expect(undo.status).toBe(204);
    const again = await server.request(`${BASE}/completions/bi_undo`, asUser(alice, { method: 'DELETE' }));
    expect(again.status).toBe(204);

    expect(await listFor(alice)).toEqual([]);
    const rows = await auditRows(alice);
    expect(rows.map(row => [row.tool_name, row.outcome])).toEqual([
      ['brief.item_undone', 'logged'],
      ['brief.item_done', 'logged'],
    ]);
  });

  it('another person cannot see or undo an item', async () => {
    const alice = uniqueName('alice');
    const bob = uniqueName('bob');
    const chat = await createChat(alice);
    await markDone(alice, itemIn(chat, 'bi_private'));

    expect(await listFor(bob)).toEqual([]);
    await server.request(`${BASE}/completions/bi_private`, asUser(bob, { method: 'DELETE' }));
    expect(await listFor(alice)).toHaveLength(1);
  });

  it('filters the list by since, and rejects a value that is not a date', async () => {
    const alice = uniqueName('alice');
    const chat = await createChat(alice);
    await markDone(alice, itemIn(chat, 'bi_since'));
    const future = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const past = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());

    expect(await listFor(alice, `?since=${future}`)).toEqual([]);
    expect(await listFor(alice, `?since=${past}`)).toHaveLength(1);

    const invalid = await server.request(`${BASE}/completions?since=yesterday`, asUser(alice));
    expect(invalid.status).toBe(400);
  });
});
