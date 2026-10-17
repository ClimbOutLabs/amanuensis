import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSentinelApi,
  readAllSessionEvents,
  SESSION_EVENTS_PAGE_SIZE,
  type SentinelApiDeps,
} from '../src/sentinelApi';

const tier2ApprovalEvent = {
  type: 'tool.approval_required',
  tool_call_id: 'call-1',
  tier: 2,
  tier3_card: { plain_what: 'Change `notes.md` in your workspace.', plain_why: 'You asked for it.' },
};

const approvalEvent = {
  type: 'tool.approval_required',
  tool_call_id: 'call-2',
  tier: 3,
  tier3_card: { plain_what: 'Send money', plain_why: 'You asked for it.' },
};

const auditEntry = {
  id: 'entry-1',
  conversation_id: 'session-1',
  created_at: '2026-09-29T10:00:00.000Z',
  tier: 2,
  tool_name: 'exec',
  description: 'Wrote a file',
  outcome: 'ran',
};

type SeenRequest = { url: string; method: string; body: unknown };

/** Records every request the API makes and answers GETs with scripted bodies. */
function recordingApi(getBody: (url: string) => unknown): {
  api: ReturnType<typeof createSentinelApi>;
  seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, method, body });
    return Response.json(getBody(url));
  };
  const deps: SentinelApiDeps = {
    fetcher,
    listSessionEvents: async () => [tier2ApprovalEvent, approvalEvent],
  };
  return { api: createSentinelApi(deps), seen };
}

test('audit entries list parses the envelope and pages by limit', async () => {
  const { api, seen } = recordingApi(() => ({ entries: [auditEntry] }));
  const entries = await api.listAuditEntries({ sessionId: 'session-1', limit: 25 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.description, 'Wrote a file');
  assert.equal(seen[0]?.url, '/api/v1/sessions/session-1/audit-log?limit=25');
  assert.equal(seen[0]?.method, 'GET');
});

test('user settings read and patch the server envelope', async () => {
  const { api, seen } = recordingApi(() => ({
    data: { offline_mode: false, tier2_auto_allow: ['file_write'], search_without_asking: false },
  }));
  assert.deepEqual(await api.getUserSettings(), {
    offline_mode: false,
    tier2_auto_allow: ['file_write'],
    search_without_asking: false,
  });
  assert.equal(seen[0]?.url, '/api/v1/user/settings/sentinel');
  assert.equal(seen[0]?.method, 'GET');

  const updated = await api.updateUserSettings({ tier2_auto_allow: ['file_write'] });
  assert.deepEqual(updated.tier2_auto_allow, ['file_write']);
  assert.equal(seen[1]?.method, 'PATCH');
  assert.deepEqual(seen[1]?.body, { tier2_auto_allow: ['file_write'] });
});

test('a missing settings route surfaces an error instead of reading as defaults', async () => {
  const fetcher: typeof fetch = async () => new Response(null, { status: 404 });
  const api = createSentinelApi({ fetcher, listSessionEvents: async () => [] });
  await assert.rejects(api.getUserSettings(), /Request failed \(404\)/);
});

test('session context folds persisted events into approvals of both tiers', async () => {
  const { api } = recordingApi(() => ({}));
  const context = await api.listSentinelSessionContext('session-1');
  assert.deepEqual(
    context.approvals.map(approval => [approval.toolCallId, approval.tier]),
    [
      ['call-1', 2],
      ['call-2', 3],
    ],
  );
});

test('session context carries how each send ended, so a reloaded chat shows the receipt', async () => {
  const receipt = {
    type: 'aman.email.send_receipt',
    toolCallId: 'call-3',
    result: {
      outcome: 'sent',
      sentAt: '2026-10-17T09:12:00.000Z',
      sentMessageId: 'm-1',
      checkCode: 'A7F39C',
      message: { to: ['grace@example.com'], cc: [], bcc: [], subject: 'Lease', body: 'Thursday works.' },
    },
  };
  const api = createSentinelApi({
    fetcher: async () => Response.json({}),
    listSessionEvents: async () => [approvalEvent, receipt],
  });
  const context = await api.listSentinelSessionContext('session-1');
  assert.equal(context.receipts?.['call-3']?.outcome, 'sent');
  assert.equal(context.receipts?.['call-3']?.toolCallId, 'call-3');
});

test('a failed audit request surfaces the server error', async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({ error: { message: 'Audit log unavailable.' } }, { status: 503 });
  const api = createSentinelApi({
    fetcher,
    listSessionEvents: async () => [],
  });
  await assert.rejects(api.listAuditEntries({ sessionId: 'session-1' }), /Audit log unavailable/);
});

test('readAllSessionEvents pages through every event without asking for more than the server serves', async () => {
  const requested: { limit: number; pageToken: string | undefined }[] = [];
  const pages = new Map<string | undefined, { data: { event: unknown }[]; nextPageToken: string | undefined }>([
    [undefined, { data: [{ event: 'a' }, { event: 'b' }], nextPageToken: 'p2' }],
    ['p2', { data: [{ event: 'c' }], nextPageToken: undefined }],
  ]);

  const events = await readAllSessionEvents(async input => {
    requested.push({ limit: input.limit, pageToken: input.pageToken });
    const page = pages.get(input.pageToken);
    if (page === undefined) throw new Error('unexpected page');
    return page;
  });

  assert.deepEqual(events, ['a', 'b', 'c']);
  assert.deepEqual(
    requested.map(request => request.pageToken),
    [undefined, 'p2'],
  );
  assert.ok(requested.every(request => request.limit <= SESSION_EVENTS_PAGE_SIZE));
  assert.equal(SESSION_EVENTS_PAGE_SIZE, 100);
});
