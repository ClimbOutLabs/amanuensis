/**
 * The fake tool-call failures from the owner's self-hosted model: leaked markup claiming work
 * that never ran, flooded and duplicated calls, arguments a tool cannot take, and reads of
 * things not yet created. Each test drives a full turn with a scripted model and checks what
 * ran, what the person was shown, and what was saved.
 */
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  RawToolCall,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType, type ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { TOO_MANY_TOOL_CALLS_MESSAGE } from '../../../src/core/runtime/modelReplyGuard';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

const CREATE_SCHEMA = {
  type: 'object' as const,
  properties: {
    title: { type: 'string' },
    start: {
      type: 'object',
      properties: { date_time: { type: 'string' }, time_zone: { type: 'string' } },
      required: ['date_time'],
    },
    end: {
      type: 'object',
      properties: { date_time: { type: 'string' }, time_zone: { type: 'string' } },
      required: ['date_time'],
    },
  },
  required: ['title', 'start'],
};

const VALID_CREATE_ARGS = {
  title: 'Dentist',
  start: { date_time: '2026-10-27T14:30:00', time_zone: 'America/New_York' },
  end: { date_time: '2026-10-27T15:00:00', time_zone: 'America/New_York' },
};

function makeToolSet(approvalRequired = false) {
  const toolSet = makeMockIMCPServer({
    name: 'google_calendar',
    preload: true,
    tools: [
      { name: 'create_event', description: 'Add an event', inputSchema: CREATE_SCHEMA, preload: true },
      {
        name: 'get_event',
        description: 'Read an event',
        inputSchema: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
        preload: true,
      },
      {
        name: 'web_fetch',
        description: 'Fetch a page',
        inputSchema: {
          type: 'object',
          properties: {
            urls: { type: 'array', items: { type: 'string' } },
            full_content: { type: 'boolean' },
          },
          required: ['urls'],
        },
        preload: true,
      },
      {
        name: 'list_events',
        description: 'List events',
        inputSchema: { type: 'object', properties: {} },
        preload: true,
      },
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation((params: CallToolRequest['params']) =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: approvalRequired && params.name === 'create_event',
    }),
  );
  jest.mocked(toolSet.callTool).mockImplementation(() => Promise.resolve(toolResultResponse({ text: '{"ok":true}' })));
  return toolSet;
}

type CallSpec = { id: string; name: string; args: Record<string, unknown> | string };

function rawCall(spec: CallSpec): RawToolCall {
  return {
    id: spec.id,
    type: 'function',
    function: {
      name: spec.name,
      arguments: typeof spec.args === 'string' ? spec.args : JSON.stringify(spec.args),
    },
  };
}

/** One streamed reply carrying the given calls (and optionally text and a markup outcome). */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* replyStream(input: {
  calls?: CallSpec[];
  text?: string;
  toolMarkup?: 'recovered';
  /** Overrides the finish reason, e.g. `length` for a reply cut off at the output limit. */
  finishReason?: 'length';
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const calls = (input.calls ?? []).map(rawCall);
  if (input.text !== undefined) {
    yield {
      id: 'chunk-text',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: input.text }, finish_reason: null }],
    };
  }
  if (calls.length > 0) {
    yield {
      id: 'chunk-calls',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: calls.map((call, index) => ({ index, ...call })),
          },
          finish_reason: null,
        },
      ],
    };
  }
  return {
    output: {
      role: 'assistant',
      content: input.text ?? null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    },
    usage: getEmptyUsage(),
    finish_reason: input.finishReason ?? (calls.length > 0 ? 'tool_calls' : 'stop'),
    ...(input.toolMarkup === undefined ? {} : { tool_markup: input.toolMarkup }),
  };
}

function makeThread(input: {
  toolSet: ReturnType<typeof makeToolSet>;
  create: ILLM['create'];
  context?: ContextMessage[];
}) {
  return new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient: { create: input.create, createNonStream: jest.fn() },
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [input.toolSet],
    },
    context: input.context ?? [{ role: 'user', content: 'Please add the appointment.' }],
  });
}

async function drain(thread: AgentThread): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

function toolResults(thread: AgentThread): { tool_call_id: string; content: string }[] {
  return thread
    .toSnapshot()
    .context.filter(
      (message): message is { role: 'tool'; tool_call_id: string; content: string } =>
        'role' in message && message.role === 'tool',
    );
}

function lastAssistant(thread: AgentThread) {
  const assistants = thread.toSnapshot().context.filter(message => 'role' in message && message.role === 'assistant');
  return assistants.at(-1);
}

function callToolNames(toolSet: ReturnType<typeof makeToolSet>): string[] {
  return jest.mocked(toolSet.callTool).mock.calls.map(call => call[0].name);
}

describe('leaked markup', () => {
  it('runs a call recovered from markup through the normal path', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          text: 'Let me add that for you. ',
          calls: [{ id: 'markup-recovered-0', name: 'create_event', args: VALID_CREATE_ARGS }],
          toolMarkup: 'recovered',
        });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    expect(callToolNames(toolSet)).toEqual(['create_event']);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });
});

describe('argument checking', () => {
  it('does not send full_content "[" and tells the model plainly what it should be', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          calls: [{ id: 'fetch-1', name: 'web_fetch', args: { urls: ['https://example.com'], full_content: '[' } }],
        });
      }
      if (round === 2) {
        return replyStream({
          calls: [{ id: 'fetch-2', name: 'web_fetch', args: { urls: ['https://example.com'], full_content: 'true' } }],
        });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);

    // The bad call never reached the tool; the retry (with "true" as text) was repaired and ran.
    expect(callToolNames(toolSet)).toEqual(['web_fetch']);
    const sent = jest.mocked(toolSet.callTool).mock.calls[0]?.[0];
    expect(sent?.arguments?.['full_content']).toBe(true);

    const results = toolResults(thread);
    const refused = results.find(
      result => result.tool_call_id.endsWith('fetch-1') || result.content.includes('full_content'),
    );
    expect(refused?.content).toContain('full_content should be true or false');
    expect(refused?.content).toContain('was not sent');
    // Nothing the person sees carries a provider's raw validation text.
    expect(JSON.stringify(events)).not.toContain('invalid_type');
    expect(JSON.stringify(events)).not.toContain('anyOf');
  });

  it('runs a call whose arguments streamed as empty text when the tool needs none', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({ calls: [{ id: 'list-1', name: 'list_events', args: '' }] });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    expect(callToolNames(toolSet)).toEqual(['list_events']);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });

  it('refuses empty-text arguments with the plain argument message when a field is required', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({ calls: [{ id: 'fetch-1', name: 'web_fetch', args: '' }] });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    await drain(thread);
    expect(toolSet.callTool).not.toHaveBeenCalled();
    const results = toolResults(thread);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('urls should be a list (this one is required)');
    expect(results[0]?.content).not.toContain('not complete');
  });

  it('never runs a call whose arguments are half-formed JSON', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          calls: [
            { id: 'call-1', name: 'create_event', args: '{"title": "Dentist", "start": {"date_time": "2026-10-27T14:' },
          ],
        });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    await drain(thread);
    expect(toolSet.callTool).not.toHaveBeenCalled();
    const results = toolResults(thread);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('arguments were not complete');
  });

  it('keeps a tool call a length-cut reply left incomplete, so the model gets the correction and the turn goes on', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          calls: [
            { id: 'call-1', name: 'create_event', args: '{"title": "Dentist", "start": {"date_time": "2026-10-27T14:' },
          ],
          finishReason: 'length',
        });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    expect(toolSet.callTool).not.toHaveBeenCalled();
    const results = toolResults(thread);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('arguments were not complete');
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
    expect(thread.getAgentThreadMetrics().total_truncated_tool_calls).toBe(1);
  });

  it('still ends the turn with the cut-off error when a length-cut reply has no tool call', async () => {
    const toolSet = makeToolSet();
    const create = jest.fn((_request: LLMCreateParamsStreaming) =>
      replyStream({ text: 'The answer is', finishReason: 'length' }),
    );
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    expect(create).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'error' });
    expect(thread.getAgentThreadMetrics().total_truncated_tool_calls).toBeUndefined();
  });
});

describe('duplicates, floods and dependent reads', () => {
  it('merges 22 identical reads in one reply into a single run', async () => {
    const toolSet = makeToolSet();
    const seeded: ContextMessage[] = [
      { role: 'user', content: 'Add my appointment, then read the dentist event back.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'seed-1',
            type: 'function',
            function: { name: 'list_events', arguments: '{}' },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 'google_calendar',
              mcp_server_name: 'google_calendar',
              original_tool_name: 'list_events',
              is_approval_required: false,
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'seed-1', content: '{"events":[{"id":"evt-1","title":"Dentist"}]}' },
    ];
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          calls: [
            { id: 'create-1', name: 'create_event', args: VALID_CREATE_ARGS },
            ...Array.from({ length: 22 }, (_, index) => ({
              id: `get-${String(index)}`,
              name: 'get_event',
              args: { event_id: 'evt-1' },
            })),
          ],
        });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create, context: seeded });
    const events = await drain(thread);
    expect(callToolNames(toolSet)).toEqual(['create_event', 'get_event']);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });

  it('does not run a read of an event the same reply is only just creating', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          calls: [
            { id: 'create-1', name: 'create_event', args: VALID_CREATE_ARGS },
            { id: 'get-1', name: 'get_event', args: { event_id: 'evt-not-created-yet' } },
          ],
        });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    await drain(thread);
    expect(callToolNames(toolSet)).toEqual(['create_event']);
    const results = toolResults(thread);
    expect(results.find(result => result.content.includes('has not been created yet'))).toBeDefined();
  });

  it('gives one approval card for two identical creates in one reply', async () => {
    const toolSet = makeToolSet(true);
    const create = jest.fn((_request: LLMCreateParamsStreaming) =>
      replyStream({
        calls: [
          { id: 'create-1', name: 'create_event', args: VALID_CREATE_ARGS },
          { id: 'create-2', name: 'create_event', args: VALID_CREATE_ARGS },
        ],
      }),
    );
    const thread = makeThread({ toolSet, create });
    await drain(thread);
    // Nothing ran (approval is still pending) and exactly one call waits for the owner.
    expect(toolSet.callTool).not.toHaveBeenCalled();
    const saved = lastAssistant(thread);
    expect(saved?.role).toBe('assistant');
    if (saved?.role === 'assistant') {
      expect(saved.tool_calls).toHaveLength(1);
      expect(saved.tool_calls?.[0]?.tool_info.is_approval_required).toBe(true);
    }
  });

  it('runs a full reply of 20 different calls, one under the cap', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          calls: Array.from({ length: 20 }, (_, index) => ({
            id: `get-${String(index)}`,
            name: 'get_event',
            args: { event_id: `evt-${String(index)}` },
          })),
        });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    expect(callToolNames(toolSet)).toHaveLength(20);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });

  it('stops the turn when one reply asks for more than 20 tool calls', async () => {
    const toolSet = makeToolSet();
    const create = jest.fn((_request: LLMCreateParamsStreaming) =>
      replyStream({
        calls: Array.from({ length: 21 }, (_, index) => ({
          id: `get-${String(index)}`,
          name: 'get_event',
          args: { event_id: `evt-${String(index)}` },
        })),
      }),
    );
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        error: TOO_MANY_TOOL_CALLS_MESSAGE,
      }),
    );
    expect(toolSet.callTool).not.toHaveBeenCalled();
  });
});
