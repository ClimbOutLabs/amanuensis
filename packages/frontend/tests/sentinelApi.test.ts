import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSentinelApi, type SentinelApiDeps } from '../src/sentinelApi';

const noticeEvent = {
  type: 'tool.tier2_notice',
  tool_call_id: 'call-1',
  tier: 2,
  tier2_kind: 'file_write',
  message: 'Wrote a file',
  undoable: true,
  stoppable: false,
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
    listSessionEvents: async () => [noticeEvent, approvalEvent],
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

test('user settings fall back to defaults on a 404 and round-trip a patch', async () => {
  const patcher: SeenRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'PATCH') {
      patcher.push({ url, method: 'PATCH', body: JSON.parse(String(init.body)) });
      return Response.json({ offline_mode: true, tier2_always_ask: [] });
    }
    return new Response(null, { status: 404 });
  };
  const api = createSentinelApi({
    fetcher,
    listSessionEvents: async () => [],
  });
  assert.deepEqual(await api.getUserSettings(), { offline_mode: false, tier2_always_ask: [] });
  const updated = await api.updateUserSettings({ offline_mode: true });
  assert.equal(updated.offline_mode, true);
  assert.deepEqual(patcher[0]?.body, { offline_mode: true });
});

test('undo and stop post to the notice endpoints with encoded ids', async () => {
  const { api, seen } = recordingApi(() => ({}));
  await api.undoTier2Action({ sessionId: 'session-1', noticeId: 'notice/2' });
  await api.stopTier2Action({ sessionId: 'session-1', noticeId: 'notice-3' });
  assert.equal(seen[0]?.url, '/api/v1/sessions/session-1/sentinel/notices/notice%2F2/undo');
  assert.equal(seen[0]?.method, 'POST');
  assert.equal(seen[1]?.url, '/api/v1/sessions/session-1/sentinel/notices/notice-3/stop');
  assert.equal(seen[1]?.method, 'POST');
});

test('session context folds persisted events into approvals and notices', async () => {
  const { api } = recordingApi(() => ({}));
  const context = await api.listSentinelSessionContext('session-1');
  assert.equal(context.approvals.length, 1);
  assert.equal(context.approvals[0]?.toolCallId, 'call-2');
  assert.equal(context.approvals[0]?.tier, 3);
  assert.equal(context.notices.length, 1);
  assert.equal(context.notices[0]?.toolCallId, 'call-1');
  assert.equal(context.notices[0]?.message, 'Wrote a file');
  assert.equal(context.notices[0]?.kind, 'file_write');
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
