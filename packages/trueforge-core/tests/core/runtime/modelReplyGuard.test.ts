/**
 * The reply guard: arguments repaired before classification, exact duplicates merged, calls that
 * must not run flagged with plain reasons, and the per-reply cap counted after merging.
 */
import type { ChatCompletionTool } from 'openai/resources/chat';
import type { RawAssistantMessage, RawToolCall } from '../../../src/core/llm/LLMTypes';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import {
  collectKnownEventIds,
  guardModelReply,
  MAX_TOOL_CALLS_PER_REPLY,
} from '../../../src/core/runtime/modelReplyGuard';

const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      parameters: {
        type: 'object',
        properties: { urls: { type: 'array', items: { type: 'string' } }, full_content: { type: 'boolean' } },
        required: ['urls'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_event',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_event',
      parameters: {
        type: 'object',
        properties: { event_id: { type: 'string' } },
        required: ['event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_events',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer' } },
      },
    },
  },
];

function call(id: string, name: string, args: Record<string, unknown> | string): RawToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

function guard(calls: RawToolCall[], knownEventIds: ReadonlySet<string> = new Set()) {
  const message: RawAssistantMessage = { role: 'assistant', content: null, tool_calls: calls };
  return guardModelReply({ message, tools: TOOLS, knownEventIds });
}

describe('guardModelReply', () => {
  it('rewrites repaired arguments into the call that will be classified', () => {
    const outcome = guard([call('a', 'web_fetch', { urls: ['https://example.com'], full_content: 'false', extra: 1 })]);
    expect(outcome.invalidCalls.size).toBe(0);
    const sent = outcome.message.tool_calls?.[0];
    expect(JSON.parse(sent?.function.arguments ?? '{}')).toEqual({
      urls: ['https://example.com'],
      full_content: false,
    });
  });

  it('flags a call whose arguments cannot be repaired, keyed by its id', () => {
    const outcome = guard([call('a', 'web_fetch', { urls: ['https://example.com'], full_content: '[' })]);
    expect(outcome.invalidCalls.get('a')).toContain('full_content should be true or false');
  });

  it('treats arguments streamed as empty text as an empty object when the tool allows one', () => {
    // A provider that streams no argument text sends the call with '' for its arguments; the
    // executor reads that as {}, so the guard must not refuse it as incomplete.
    const outcome = guard([call('a', 'list_events', '')]);
    expect(outcome.invalidCalls.size).toBe(0);
    expect(outcome.message.tool_calls).toHaveLength(1);
    expect(outcome.tooManyCalls).toBe(false);
  });

  it('sends an empty-arguments call with a required field through the plain argument message instead', () => {
    const outcome = guard([call('a', 'create_event', '')]);
    const message = outcome.invalidCalls.get('a');
    expect(message).toContain('title should be text');
    expect(message).toContain('was not sent');
    expect(message).not.toContain('not complete');
  });

  it('leaves calls to tools with no offered schema untouched', () => {
    const outcome = guard([call('a', 'mystery_tool', { anything: '[' })]);
    expect(outcome.invalidCalls.size).toBe(0);
    expect(outcome.message.tool_calls).toHaveLength(1);
  });

  it('merges exact duplicates and keeps the first', () => {
    const outcome = guard([
      call('a', 'get_event', { event_id: 'evt-1' }),
      call('b', 'get_event', { event_id: 'evt-1' }),
      call('c', 'get_event', { event_id: 'evt-2' }),
    ]);
    expect(outcome.message.tool_calls?.map(entry => entry.id)).toEqual(['a', 'c']);
    expect(outcome.tooManyCalls).toBe(false);
  });

  it('counts the cap after merging: 22 identical reads are one call, 9 different ones are too many', () => {
    const flood = guard(
      Array.from({ length: 22 }, (_, index) => call(`g${String(index)}`, 'get_event', { event_id: 'evt-1' })),
    );
    expect(flood.tooManyCalls).toBe(false);
    expect(flood.message.tool_calls).toHaveLength(1);

    const varied = guard(
      Array.from({ length: MAX_TOOL_CALLS_PER_REPLY + 1 }, (_, index) =>
        call(`g${String(index)}`, 'get_event', { event_id: `evt-${String(index)}` }),
      ),
    );
    expect(varied.tooManyCalls).toBe(true);

    const atCap = guard(
      Array.from({ length: MAX_TOOL_CALLS_PER_REPLY }, (_, index) =>
        call(`g${String(index)}`, 'get_event', { event_id: `evt-${String(index)}` }),
      ),
    );
    expect(atCap.tooManyCalls).toBe(false);
  });

  it('counts every call toward the cap, held ones included: exempting held calls in an unattended run is the runtime recount, not the guard', () => {
    const batch = guard(
      Array.from({ length: 22 }, (_, index) =>
        call(`g${String(index)}`, 'get_event', { event_id: `evt-${String(index)}` }),
      ),
    );
    expect(batch.tooManyCalls).toBe(true);
    expect(batch.message.tool_calls).toHaveLength(22);
  });

  it('blocks a get_event for an uncreated event only when the same reply creates', () => {
    const blocked = guard([
      call('a', 'create_event', { title: 'Dentist' }),
      call('b', 'get_event', { event_id: 'evt-new' }),
    ]);
    expect(blocked.invalidCalls.get('b')).toContain('has not been created yet');

    const known = guard(
      [call('a', 'create_event', { title: 'Dentist' }), call('b', 'get_event', { event_id: 'evt-new' })],
      new Set(['evt-new']),
    );
    expect(known.invalidCalls.size).toBe(0);

    const noCreate = guard([call('b', 'get_event', { event_id: 'evt-new' })]);
    expect(noCreate.invalidCalls.size).toBe(0);
  });
});

describe('collectKnownEventIds', () => {
  it('finds ids in tool results, earlier calls and pasted text', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'Context: {"id": "evt-pasted"}' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'get_event', arguments: '{"event_id":"evt-read"}' },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 's',
              mcp_server_name: 's',
              original_tool_name: 'get_event',
              is_approval_required: false,
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"event":{"id":"evt-1","title":"Dentist"}}' },
    ];
    expect(collectKnownEventIds(context)).toEqual(new Set(['evt-pasted', 'evt-read', 'evt-1']));
  });
});
