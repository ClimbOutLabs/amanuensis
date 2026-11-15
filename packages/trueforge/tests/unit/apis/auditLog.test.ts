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
      is_incognito: false,
      private_expires_at: null,
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
        session_title: null,
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

  it('filters by a from and to time, keeping the entries on both covered boundary instants', async () => {
    const CAROL = 'carol@audit.example';
    const row = (tool_name: string, created_at: string) => ({
      id: `carol-${tool_name}`,
      conversation_id: 'carol-chat',
      tier: 3,
      tool_name,
      description: `Entry ${tool_name}`,
      outcome: 'approved' as const,
      auto_deny_reason: null,
      created_at,
    });
    await new SentinelAuditStore(server.db()).importRecords({
      tenant_id: 'default',
      created_by: CAROL,
      records: [
        row('just_before', '2026-09-30T23:59:59.999Z'),
        row('at_from', '2026-10-01T00:00:00.000Z'),
        row('middle', '2026-10-02T12:00:00.000Z'),
        row('last_covered', '2026-10-03T23:59:59.999Z'),
        row('at_to', '2026-10-04T00:00:00.000Z'),
      ],
    });

    const from = encodeURIComponent('2026-10-01T00:00:00.000Z');
    const to = encodeURIComponent('2026-10-04T00:00:00.000Z');
    const ranged = await list(CAROL, `?from=${from}&to=${to}`);
    expect(ranged.data.map(entry => entry.tool_name)).toEqual(['last_covered', 'middle', 'at_from']);

    const fromOnly = await list(CAROL, `?from=${from}`);
    expect(fromOnly.data.map(entry => entry.tool_name)).toEqual(['at_to', 'last_covered', 'middle', 'at_from']);

    const toOnly = await list(CAROL, `?to=${to}`);
    expect(toOnly.data.map(entry => entry.tool_name)).toEqual(['last_covered', 'middle', 'at_from', 'just_before']);

    expect((await server.request(`${AUDIT_PATH}?from=not-a-time`, asUser(CAROL))).status).toBe(400);
    expect((await server.request(`${AUDIT_PATH}?to=2026-10-04`, asUser(CAROL))).status).toBe(400);
  });

  it('reads a bound with an offset or without milliseconds as the same instant', async () => {
    const DAVE = 'dave@audit.example';
    const row = (tool_name: string, created_at: string) => ({
      id: `dave-${tool_name}`,
      conversation_id: 'dave-chat',
      tier: 3,
      tool_name,
      description: `Entry ${tool_name}`,
      outcome: 'approved' as const,
      auto_deny_reason: null,
      created_at,
    });
    await new SentinelAuditStore(server.db()).importRecords({
      tenant_id: 'default',
      created_by: DAVE,
      records: [
        row('before', '2026-09-30T18:29:59.999Z'),
        row('at_start', '2026-09-30T18:30:00.000Z'),
        row('exported_with_offset', '2026-10-01T09:00:00+05:30'),
        row('at_end', '2026-10-01T18:30:00.000Z'),
      ],
    });

    // The start of 1 October in India, sent with its offset, is 18:30 UTC the day before.
    const from = encodeURIComponent('2026-10-01T00:00:00+05:30');
    const to = encodeURIComponent('2026-10-02T00:00:00+05:30');
    const offsetBounds = await list(DAVE, `?from=${from}&to=${to}`);
    expect(offsetBounds.data.map(entry => entry.tool_name)).toEqual(['exported_with_offset', 'at_start']);

    // Without milliseconds, an exact instant is still the same instant.
    const noMillis = await list(DAVE, `?from=${encodeURIComponent('2026-09-30T18:30:00Z')}`);
    expect(noMillis.data.map(entry => entry.tool_name)).toEqual(['at_end', 'exported_with_offset', 'at_start']);
    const toNoMillis = await list(DAVE, `?to=${encodeURIComponent('2026-10-01T18:30:00Z')}`);
    expect(toNoMillis.data.map(entry => entry.tool_name)).toEqual(['exported_with_offset', 'at_start', 'before']);
  });

  it('refuses a start that is not before the end, with the next step', async () => {
    const response = await server.request(
      `${AUDIT_PATH}?from=${encodeURIComponent('2026-10-05T00:00:00.000Z')}&to=${encodeURIComponent('2026-10-01T00:00:00.000Z')}`,
      asUser(ALICE),
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('Pick an earlier start date');
  });
});
