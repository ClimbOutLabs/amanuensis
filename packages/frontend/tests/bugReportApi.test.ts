import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBugReportApi } from '../src/bugReportApi';

const bundle = {
  schema_version: 1,
  generated_at: '2026-09-05T00:00:00.000Z',
  build: { version: '0.1.4' },
  session: {
    id: 's1',
    agent_name: null,
    model: 'local',
    created_at: '2026-09-05T00:00:00.000Z',
    connectors: ['parallel-web'],
    skills: [],
    sandbox_enabled: true,
  },
  user_description: '',
  summary: ['Turn 1: user wrote 30 chars. No tools ran. Turn finished after 2 s.'],
  trace: [
    {
      turn_id: 't1',
      events: [
        { type: 'turn.created', at_ms: 0 },
        { type: 'model.message', role: 'assistant', char_count: 12, tool_names: ['exec'], finish_reason: 'tool_calls' },
        { type: 'tool.response.v2', tool_name: 'exec', outcome: 'executed_nonzero', exit_code: 1, intent: 'Run it' },
      ],
    },
  ],
  recent_errors: [],
  config_flags: { sandbox_enabled: false, skill_enabled: false, settings_enabled: true },
  redaction: { stripped_fields: [], notes: 'structure only' },
};

function fetcherReturning(data: unknown, capture: { body?: string }): typeof fetch {
  const fetcher: typeof fetch = async (_url, init) => {
    capture.body = typeof init?.body === 'string' ? init.body : undefined;
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return fetcher;
}

test('sends the include_chat choice and leaves chat out of a bundle that carries none', async () => {
  const capture: { body?: string } = {};
  const api = createBugReportApi(fetcherReturning(bundle, capture));
  const result = await api.generateBugReport({ sessionId: 's1', description: 'x', includeChat: false });
  assert.deepEqual(JSON.parse(capture.body ?? '{}'), { description: 'x', include_chat: false });
  assert.equal('chat' in result, false);
  assert.deepEqual(result.summary, bundle.summary);
  assert.deepEqual(result.session.connectors, ['parallel-web']);
  assert.equal(result.session.sandbox_enabled, true);
  assert.deepEqual(result.trace[0]?.events[2], {
    type: 'tool.response.v2',
    tool_name: 'exec',
    outcome: 'executed_nonzero',
    exit_code: 1,
    intent: 'Run it',
  });
});

test('parses the opted-in chat and drops malformed messages', async () => {
  const capture: { body?: string } = {};
  const withChat = {
    ...bundle,
    chat: {
      messages: [
        { turn_id: 't1', role: 'user', text: 'hello' },
        { turn_id: 't1', role: 'assistant', text: 'hi', truncated: true },
        { turn_id: 't1', role: 'tool', text: 'not a chat role' },
      ],
      notes: 'included at the reporter request',
      omitted_messages: 2,
    },
  };
  const api = createBugReportApi(fetcherReturning(withChat, capture));
  const result = await api.generateBugReport({ sessionId: 's1', description: '', includeChat: true });
  assert.deepEqual(JSON.parse(capture.body ?? '{}'), { description: '', include_chat: true });
  assert.deepEqual(result.chat, {
    messages: [
      { turn_id: 't1', role: 'user', text: 'hello' },
      { turn_id: 't1', role: 'assistant', text: 'hi', truncated: true },
    ],
    notes: 'included at the reporter request',
    omitted_messages: 2,
  });
});

const appBundle = {
  schema_version: 1,
  generated_at: '2026-09-05T00:00:00.000Z',
  build: { version: '0.1.4' },
  user_description: 'It broke',
  config_flags: { sandbox_enabled: true, skill_enabled: false, settings_enabled: true },
  redaction: { stripped_fields: ['session.id and all session metadata (no session is attached)'], notes: 'app-level' },
};

test('posts to /api/v1/bug-reports and parses the app-level bundle without a session', async () => {
  const capture: { url?: string; body?: string } = {};
  const fetcher: typeof fetch = async (url, init) => {
    capture.url = typeof url === 'string' ? url : url.toString();
    capture.body = typeof init?.body === 'string' ? init.body : undefined;
    return new Response(JSON.stringify({ data: appBundle }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const api = createBugReportApi(fetcher);
  const result = await api.generateAppBugReport({ description: 'It broke' });
  assert.equal(capture.url, '/api/v1/bug-reports');
  assert.deepEqual(JSON.parse(capture.body ?? '{}'), { description: 'It broke' });
  assert.equal(result.user_description, 'It broke');
  assert.equal(result.build.version, '0.1.4');
  assert.deepEqual(result.config_flags, { sandbox_enabled: true, skill_enabled: false, settings_enabled: true });
  assert.equal('session' in result, false);
  assert.equal('trace' in result, false);
  assert.equal('chat' in result, false);
});

test('rejects a malformed app-level bundle', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ data: { ...appBundle, config_flags: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const api = createBugReportApi(fetcher);
  await assert.rejects(() => api.generateAppBugReport({ description: '' }), /invalid/);
});

test('reads the handoff target, mapping null when the host disabled it', async () => {
  const capture: { urls: string[] } = { urls: [] };
  const fetcherFor =
    (data: unknown): typeof fetch =>
    async url => {
      capture.urls.push(typeof url === 'string' ? url : url.toString());
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

  const withUrl = createBugReportApi(
    fetcherFor({ issue_url: 'https://github.com/acme/repo/issues/new?template=bug_report.yml' }),
  );
  assert.deepEqual(await withUrl.getBugReportHandoff(), {
    issueUrl: 'https://github.com/acme/repo/issues/new?template=bug_report.yml',
  });

  const withoutUrl = createBugReportApi(fetcherFor({ issue_url: null }));
  assert.equal(await withoutUrl.getBugReportHandoff(), null);
  assert.equal(capture.urls[1], '/api/v1/bug-reports/handoff');
});

test('rejects a malformed handoff target', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ data: { issue_url: 42 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const api = createBugReportApi(fetcher);
  await assert.rejects(() => api.getBugReportHandoff(), /invalid/);
});
