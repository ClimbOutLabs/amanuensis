/**
 * The fake tool-call failures from the owner's self-hosted model: leaked markup claiming work
 * that never ran, flooded and duplicated calls, arguments a tool cannot take, and reads of
 * things not yet created. Each test drives a full turn with a scripted model and checks what
 * ran, what the person was shown, and what was saved.
 */
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  RawToolCall,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { TOOL_MARKUP_NOTICE, UNBACKED_CLAIM_NOTE } from '../../../src/core/llm/replyNotices';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import {
  createToolCallMemoState,
  createTurnToolCallLedger,
  MAX_TOOL_MARKUP_RETRIES_PER_TURN,
  MAX_WRITE_CALLS_PER_TURN,
  mergeTurnToolCallLedgers,
  type TurnToolCallLedger,
} from '../../../src/core/mcp/executeToolCalls';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType, type ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { TOO_MANY_TOOL_CALLS_MESSAGE } from '../../../src/core/runtime/modelReplyGuard';
import {
  REPEATED_ACTION_RESULT,
  TOOL_MARKUP_RETRY_MESSAGE,
  WRITE_CAP_BLOCKED_RESULT,
  WRITE_CAP_STOP_MESSAGE,
} from '../../../src/core/runtime/replyActionChecks';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { isRecord } from '../../../src/core/util/records';
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
    notify_guests: { type: 'boolean' },
  },
  required: ['title', 'start'],
};

const VALID_CREATE_ARGS = {
  title: 'Dentist',
  start: { date_time: '2026-10-27T14:30:00', time_zone: 'America/New_York' },
  end: { date_time: '2026-10-27T15:00:00', time_zone: 'America/New_York' },
};

function makeToolSet(approvalRequired = false, readOnlyTools: ReadonlySet<string> = new Set()) {
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
      ...(readOnlyTools.has(params.name) ? { read_only_hint: true } : {}),
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
  toolMarkup?: 'leaked';
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
    finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
    ...(input.toolMarkup === undefined ? {} : { tool_markup: input.toolMarkup }),
  };
}

function makeThread(input: {
  toolSet: ReturnType<typeof makeToolSet>;
  create: ILLM['create'];
  context?: ContextMessage[];
  turnToolCallLedger?: TurnToolCallLedger | undefined;
}) {
  return new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: input.turnToolCallLedger,
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

/** The error text a refused call's result carries, read out of its JSON envelope. */
function refusalError(content: string | undefined): unknown {
  const parsed: unknown = JSON.parse(content ?? '{}');
  return isRecord(parsed) && isRecord(parsed['result']) ? parsed['result']['error'] : undefined;
}

function lastAssistant(thread: AgentThread) {
  const assistants = thread.toSnapshot().context.filter(message => 'role' in message && message.role === 'assistant');
  return assistants.at(-1);
}

function callToolNames(toolSet: ReturnType<typeof makeToolSet>): string[] {
  return jest.mocked(toolSet.callTool).mock.calls.map(call => call[0].name);
}

function deliveredText(events: unknown[]): string {
  return events
    .map(event => (isRecord(event) && event['type'] === EventType.MODEL_MESSAGE_DELTA ? event['content'] : undefined))
    .filter((content): content is string => typeof content === 'string')
    .join('');
}

describe('leaked markup', () => {
  it('never runs a call written as text, tells the model it did not run, and adds the plain line when no write succeeded', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({ text: 'Setting the reminder now.\n', toolMarkup: 'leaked' })
        : replyStream({ text: 'I could not set it.\n' });
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);

    expect(callToolNames(toolSet)).toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls[1]?.[0])).toContain(TOOL_MARKUP_RETRY_MESSAGE);
    // The retried answer reuses the leaked step's message id, so live clients replace that stream; the
    // delivered deltas end with the retried answer and the plain line.
    expect(deliveredText(events)).toMatch(new RegExp(`I could not set it\\.\\n\\n${TOOL_MARKUP_NOTICE}$`));
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });

  it('ends the turn after the retry cap, still with no call run', async () => {
    const toolSet = makeToolSet();
    const create = jest.fn((_request: LLMCreateParamsStreaming) =>
      replyStream({ text: 'Setting the reminder now.\n', toolMarkup: 'leaked' }),
    );
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);

    expect(callToolNames(toolSet)).toEqual([]);
    expect(create).toHaveBeenCalledTimes(MAX_TOOL_MARKUP_RETRIES_PER_TURN + 1);
    expect(deliveredText(events)).toContain(TOOL_MARKUP_NOTICE);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });

  it('adds nothing for leaked markup when a write already succeeded in the turn', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({ calls: [{ id: 'call-create', name: 'create_event', args: VALID_CREATE_ARGS }] });
      }
      return replyStream({ text: 'The reminder is in place.\n', toolMarkup: 'leaked' });
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);

    expect(callToolNames(toolSet)).toEqual(['create_event']);
    expect(deliveredText(events)).not.toContain(TOOL_MARKUP_NOTICE);
  });

  it('adds the unbacked-claim note when the reply says it set something and no write call ran', async () => {
    const toolSet = makeToolSet();
    const create = jest.fn((_request: LLMCreateParamsStreaming) =>
      replyStream({ text: "Done, I've set a 9:10 reminder." }),
    );
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);

    expect(callToolNames(toolSet)).toEqual([]);
    expect(deliveredText(events)).toBe(`Done, I've set a 9:10 reminder.\n\n${UNBACKED_CLAIM_NOTE}`);
  });

  it('leaves the reply alone when a write call succeeded in the same turn', async () => {
    const toolSet = makeToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({ calls: [{ id: 'call-create', name: 'create_event', args: VALID_CREATE_ARGS }] });
      }
      return replyStream({ text: "Done, I've set a 9:10 reminder." });
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);

    expect(callToolNames(toolSet)).toEqual(['create_event']);
    expect(deliveredText(events)).toBe("Done, I've set a 9:10 reminder.");
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
    expect(refusalError(refused?.content)).toContain(
      'full_content must be true or false, for example "full_content": true, or leave it out',
    );
    expect(refused?.content).toContain('was not sent');
    // Nothing the person sees carries a provider's raw validation text.
    expect(JSON.stringify(events)).not.toContain('invalid_type');
    expect(JSON.stringify(events)).not.toContain('anyOf');
  });

  it('runs a read-only web_fetch once with an unusable full_content left out', async () => {
    const toolSet = makeToolSet(false, new Set(['web_fetch']));
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          calls: [
            {
              id: 'fetch-1',
              name: 'web_fetch',
              args: { urls: ['https://example.com'], full_content: '> ' },
            },
          ],
        });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);

    expect(callToolNames(toolSet)).toEqual(['web_fetch']);
    const sent = jest.mocked(toolSet.callTool).mock.calls[0]?.[0];
    expect(sent?.arguments).toEqual({ urls: ['https://example.com'] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });

  it('still refuses a tool that changes something when its optional true-or-false value is unusable', async () => {
    const toolSet = makeToolSet(false, new Set(['web_fetch']));
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          calls: [{ id: 'create-1', name: 'create_event', args: { ...VALID_CREATE_ARGS, notify_guests: '> ' } }],
        });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    await drain(thread);

    expect(toolSet.callTool).not.toHaveBeenCalled();
    const results = toolResults(thread);
    expect(results).toHaveLength(1);
    expect(refusalError(results[0]?.content)).toContain(
      'notify_guests must be true or false, for example "notify_guests": true, or leave it out',
    );
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
    expect(results[0]?.content).toContain('urls must be a list (this one is required)');
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

/** The calendar tool set with create_event classified as a tier 3 write, as the permission layer does. */
function makeTier3WriteToolSet() {
  const toolSet = makeToolSet();
  jest.mocked(toolSet.toolCallInfo).mockImplementation((params: CallToolRequest['params']) =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
      ...(params.name === 'create_event' ? { tier: 3 as const } : {}),
    }),
  );
  return toolSet;
}

function createArgs(title: string) {
  return { ...VALID_CREATE_ARGS, title };
}

describe('per-turn tool loop guard', () => {
  it('runs an identical call once in a reply and refuses every repeat in that reply', async () => {
    const toolSet = makeTier3WriteToolSet();
    const repeats = Array.from({ length: 19 }, (_, index) => ({
      id: `call-${String(index)}`,
      name: 'create_event',
      args: VALID_CREATE_ARGS,
    }));
    const create = jest.fn((_request: LLMCreateParamsStreaming) => replyStream({ calls: repeats }));
    const thread = makeThread({ toolSet, create });
    await drain(thread);

    expect(callToolNames(toolSet)).toEqual(['create_event']);
    const refused = toolResults(thread).filter(result => result.content.includes(REPEATED_ACTION_RESULT));
    expect(refused.length).toBeGreaterThan(0);
  });

  it('refuses an identical call made again in a later step of the same turn', async () => {
    const toolSet = makeTier3WriteToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round <= 2) {
        return replyStream({ calls: [{ id: `call-${String(round)}`, name: 'create_event', args: VALID_CREATE_ARGS }] });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ toolSet, create });
    await drain(thread);

    expect(callToolNames(toolSet)).toEqual(['create_event']);
    expect(toolResults(thread).some(result => result.content.includes(REPEATED_ACTION_RESULT))).toBe(true);
  });

  it('stops the turn at the write cap: the write past it never runs and the person is told why', async () => {
    const toolSet = makeTier3WriteToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return replyStream({
        calls: [{ id: `call-${String(round)}`, name: 'create_event', args: createArgs(`Dentist ${String(round)}`) }],
      });
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);

    expect(MAX_WRITE_CALLS_PER_TURN).toBe(5);
    expect(callToolNames(toolSet)).toHaveLength(MAX_WRITE_CALLS_PER_TURN);
    expect(toolResults(thread).some(result => result.content.includes(WRITE_CAP_BLOCKED_RESULT))).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: InternalEventType.AGENT_DONE,
      status: 'error',
      error: WRITE_CAP_STOP_MESSAGE,
    });
  });

  it('leaves a normal turn with two writes untouched', async () => {
    const toolSet = makeTier3WriteToolSet();
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({ calls: [{ id: 'call-1', name: 'create_event', args: createArgs('Dentist') }] });
      }
      if (round === 2) {
        return replyStream({ calls: [{ id: 'call-2', name: 'create_event', args: createArgs('Cleaning') }] });
      }
      return replyStream({ text: 'Both appointments are in place.' });
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);

    expect(callToolNames(toolSet)).toEqual(['create_event', 'create_event']);
    expect(toolResults(thread).some(result => result.content.includes(WRITE_CAP_BLOCKED_RESULT))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
    expect(deliveredText(events)).toBe('Both appointments are in place.');
  });
});

describe('turn-wide counts across a resumed turn', () => {
  /** One create_event call per reply, with the given titles, then a plain final answer. */
  function scriptedWrites(titles: string[]): ILLM['create'] {
    let round = 0;
    return jest.fn((_request: LLMCreateParamsStreaming) => {
      const title = titles[round];
      round += 1;
      return title === undefined
        ? finalAnswerStream()
        : replyStream({ calls: [{ id: `call-${String(round)}`, name: 'create_event', args: createArgs(title) }] });
    });
  }

  it('keeps the write cap when a sub-agent resumes after an approval pause', async () => {
    const toolSet = makeTier3WriteToolSet();
    const paused = makeThread({
      toolSet,
      create: scriptedWrites(['Main 1', 'Main 2', 'Main 3']),
      turnToolCallLedger: createTurnToolCallLedger(),
    });
    await drain(paused);
    const resumedLedger = mergeTurnToolCallLedgers([createToolCallMemoState(paused.toSnapshot().tool_call_memo).turn]);
    const resumedSub = makeThread({
      toolSet,
      create: scriptedWrites(['A 1', 'A 2', 'A 3']),
      turnToolCallLedger: resumedLedger,
    });

    const events = await drain(resumedSub);

    expect(callToolNames(toolSet)).toHaveLength(MAX_WRITE_CALLS_PER_TURN);
    expect(resumedLedger.writeCallsThisTurn).toBe(MAX_WRITE_CALLS_PER_TURN);
    expect(resumedLedger.stoppedForWriteCap).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: InternalEventType.AGENT_DONE,
      status: 'error',
      error: WRITE_CAP_STOP_MESSAGE,
    });
  });
});

describe('mergeTurnToolCallLedgers', () => {
  it('takes the largest count from each snapshot and the root thread last call', () => {
    const root = createTurnToolCallLedger();
    root.writeCallsThisTurn = 2;
    root.lastCallSignature = 'root-call';
    root.callSignatures.set('shared', { count: 1, writesAtLastRun: 1, lastKind: null, retried: false });
    const child = createTurnToolCallLedger();
    child.writeCallsThisTurn = 4;
    child.lastCallSignature = 'child-call';
    child.callSignatures.set('shared', { count: 2, writesAtLastRun: 4, lastKind: null, retried: false });

    const merged = mergeTurnToolCallLedgers([root, child]);

    expect(merged.writeCallsThisTurn).toBe(4);
    expect(merged.lastCallSignature).toBe('root-call');
    expect(merged.callSignatures.get('shared')).toEqual({
      count: 2,
      writesAtLastRun: 4,
      lastKind: null,
      retried: false,
    });
  });
});

describe('turn-wide counts across threads', () => {
  /** One create_event call per reply, with the given titles, then a plain final answer. */
  function scriptedWrites({ prefix, titles }: { prefix: string; titles: string[] }): ILLM['create'] {
    const replies = [
      ...titles.map((title, index) => ({
        calls: [{ id: `${prefix}-${String(index)}`, name: 'create_event', args: createArgs(title) }],
      })),
    ];
    let round = 0;
    return jest.fn((_request: LLMCreateParamsStreaming) => {
      const reply = replies[round];
      round += 1;
      return reply === undefined ? finalAnswerStream() : replyStream(reply);
    });
  }

  it('counts writes from the main thread and two sub-agents toward one turn cap', async () => {
    const toolSet = makeTier3WriteToolSet();
    const turnToolCallLedger = createTurnToolCallLedger();
    const main = makeThread({
      toolSet,
      create: scriptedWrites({ prefix: 'main', titles: ['Main 1', 'Main 2'] }),
      turnToolCallLedger,
    });
    const subA = makeThread({
      toolSet,
      create: scriptedWrites({ prefix: 'a', titles: ['A 1', 'A 2'] }),
      turnToolCallLedger,
    });
    const subB = makeThread({
      toolSet,
      create: scriptedWrites({ prefix: 'b', titles: ['B 1', 'B 2', 'B 3'] }),
      turnToolCallLedger,
    });

    await drain(main);
    await drain(subA);
    const subBEvents = await drain(subB);

    expect(callToolNames(toolSet)).toHaveLength(MAX_WRITE_CALLS_PER_TURN);
    expect(turnToolCallLedger.writeCallsThisTurn).toBe(MAX_WRITE_CALLS_PER_TURN);
    expect(toolResults(subB).some(result => result.content.includes(WRITE_CAP_BLOCKED_RESULT))).toBe(true);
    expect(subBEvents.at(-1)).toMatchObject({
      type: InternalEventType.AGENT_DONE,
      status: 'error',
      error: WRITE_CAP_STOP_MESSAGE,
    });
  });

  it('refuses an identical call that a sibling thread already ran when no write ran since', async () => {
    const toolSet = makeTier3WriteToolSet();
    const turnToolCallLedger = createTurnToolCallLedger();
    const main = makeThread({
      toolSet,
      create: scriptedWrites({ prefix: 'main', titles: ['Shared'] }),
      turnToolCallLedger,
    });
    const sub = makeThread({
      toolSet,
      create: scriptedWrites({ prefix: 'sub', titles: ['Shared'] }),
      turnToolCallLedger,
    });

    await drain(main);
    await drain(sub);

    expect(callToolNames(toolSet)).toEqual(['create_event']);
    expect(toolResults(sub).some(result => result.content.includes(REPEATED_ACTION_RESULT))).toBe(true);
  });

  it('runs an identical call again when a sibling thread has run a write since it last ran', async () => {
    const toolSet = makeTier3WriteToolSet();
    const turnToolCallLedger = createTurnToolCallLedger();
    const main = makeThread({
      toolSet,
      create: scriptedWrites({ prefix: 'main', titles: ['Shared'] }),
      turnToolCallLedger,
    });
    const sub = makeThread({
      toolSet,
      create: scriptedWrites({ prefix: 'sub', titles: ['Other', 'Shared'] }),
      turnToolCallLedger,
    });

    await drain(main);
    await drain(sub);

    expect(callToolNames(toolSet)).toEqual(['create_event', 'create_event', 'create_event']);
    expect(toolResults(sub).some(result => result.content.includes(REPEATED_ACTION_RESULT))).toBe(false);
  });
});
