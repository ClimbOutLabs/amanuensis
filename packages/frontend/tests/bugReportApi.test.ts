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
