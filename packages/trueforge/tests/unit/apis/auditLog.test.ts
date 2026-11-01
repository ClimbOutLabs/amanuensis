import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import type { AuditRecordInput } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import type { Authenticator } from '../../../src/auth/authenticator';
import type { RequestContext } from '../../../src/auth/identity';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { ListUserAuditLogResponseSchema } from '../../../src/schemas/sentinelAudit';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const AUDIT_PATH = '/api/v1/user/audit-log';
const ALICE = 'alice@audit.example';
const BOB = 'bob@audit.example';

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

describe('per-user audit log route', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer({ authenticator: headerAuthenticator });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  async function createChat(user: string, sessionId: string): Promise<void> {
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
  }

  async function record(input: Partial<AuditRecordInput> & Pick<AuditRecordInput, 'created_by'>): Promise<void> {
    await new SentinelAuditStore(server.db()).record({
      tenant_id: 'default',
      conversation_id: 'unused',
      tier: 3,
      tool_name: 'send_email',
      description: 'Send an email to the landlord',
      outcome: 'approved',
      auto_deny_reason: null,
      ...input,
    });
    // Timestamps are millisecond-precise; spacing writes keeps "newest first" deterministic.
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  async function list(user: string, query = '') {
    const response = await server.request(`${AUDIT_PATH}${query}`, asUser(user));
    expect(response.status).toBe(200);
    return ListUserAuditLogResponseSchema.parse(await response.json());
  }

  it('requires authentication', async () => {
    expect((await server.request(AUDIT_PATH)).status).toBe(401);
  });

  it('keeps showing a deleted chat’s entries, only to their owner, a page at a time', async () => {
    await createChat(ALICE, 'alice-gone');
    await createChat(ALICE, 'alice-kept');
    await createChat(BOB, 'bob-chat');
    await record({ created_by: ALICE, conversation_id: 'alice-gone', tool_name: 'send_email' });
    await record({ created_by: BOB, conversation_id: 'bob-chat', tool_name: 'bob_tool' });
    await record({ created_by: ALICE, conversation_id: 'alice-kept', tool_name: 'write_file', outcome: 'ran' });
    await record({ created_by: ALICE, conversation_id: 'alice-kept', tool_name: 'exec', outcome: 'denied' });

    const deleted = await server.request('/api/v1/sessions/alice-gone', asUser(ALICE, { method: 'DELETE' }));
    expect(deleted.status).toBe(204);

    const first = await list(ALICE, '?limit=2');
    expect(first.data.map(row => [row.tool_name, row.chat_exists])).toEqual([
      ['exec', true],
      ['write_file', true],
    ]);
    const token = first.pagination.next_page_token;
    expect(token).toBeDefined();

    const second = await list(ALICE, `?limit=2&page_token=${encodeURIComponent(token ?? '')}`);
    expect(second.data).toEqual([
      expect.objectContaining({
        conversation_id: 'alice-gone',
        tool_name: 'send_email',
        description: 'Send an email to the landlord',
        outcome: 'approved',
        chat_exists: false,
      }),
    ]);
    expect(second.pagination.next_page_token).toBeUndefined();

    const bob = await list(BOB);
    expect(bob.data.map(row => row.tool_name)).toEqual(['bob_tool']);
  });

  it('filters by outcome', async () => {
    const denied = await list(ALICE, '?outcome=denied');
    expect(denied.data.map(row => row.tool_name)).toEqual(['exec']);
  });

  it('refuses a forged page token and an unknown outcome', async () => {
    expect((await server.request(`${AUDIT_PATH}?page_token=not-a-token`, asUser(ALICE))).status).toBe(400);
    expect((await server.request(`${AUDIT_PATH}?outcome=held`, asUser(ALICE))).status).toBe(400);
  });
});
