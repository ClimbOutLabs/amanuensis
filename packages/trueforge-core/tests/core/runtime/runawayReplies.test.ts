/**
 * Turn-level checks for runaway replies: a claim of finished work made in an early step of a
 * turn is held to the same check as one in the final step, and a repetition stop is logged
 * with the guard and channel that made it.
 */
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'winston';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  RawToolCall,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { isRecord } from '../../../src/core/util/records';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

const CLAIM = "I've set the reminder for 9:10.";
const NOTE = 'Nothing was changed yet: no action ran in this reply.';

const CREATE_SCHEMA = {
  type: 'object' as const,
  properties: { title: { type: 'string' } },
  required: ['title'],
};

function makeToolSet(failCreates: boolean) {
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
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation((params: CallToolRequest['params']) =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
      ...(params.name === 'get_event' ? { read_only_hint: true } : {}),
    }),
  );
  jest.mocked(toolSet.callTool).mockImplementation((params: CallToolRequest['params']) =>
    Promise.resolve(
      params.name === 'create_event' && failCreates
        ? toolResultResponse({ text: 'The calendar is unavailable.', isError: true })
        : toolResultResponse({ text: '{"ok":true}' }),
    ),
  );
  return toolSet;
}

type CallSpec = { id: string; name: string; args: Record<string, unknown> };

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture
async function* replyStream(input: {
  calls?: CallSpec[];
  text?: string;
  repetitionStopped?: boolean;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const calls: RawToolCall[] = (input.calls ?? []).map(spec => ({
    id: spec.id,
    type: 'function',
    function: { name: spec.name, arguments: JSON.stringify(spec.args) },
  }));
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
          delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, ...call })) },
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
    ...(input.repetitionStopped === true
      ? { repetition_stopped: true, repetition_stop: { guard: 'answer_units', channel: 'answer' } }
      : {}),
  };
}

function makeThread(input: { toolSet: IToolSet; create: ILLM['create']; logger?: Logger }) {
  return new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: input.logger ?? makeSilentLogger(),
    definition: {
      modelClient: { create: input.create, createNonStream: jest.fn() },
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [input.toolSet],
    },
    context: [{ role: 'user', content: 'Please add the appointment.' }] as ContextMessage[],
  });
}

async function drain(thread: AgentThread): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

function deliveredText(events: unknown[]): string {
  return events
    .map(event => (isRecord(event) && event['type'] === EventType.MODEL_MESSAGE_DELTA ? event['content'] : undefined))
    .filter((content): content is string => typeof content === 'string')
    .join('');
}

describe('claims made in an early step of a turn', () => {
  it('adds the note when the claim came in an early step and only a read ran', async () => {
    const toolSet = makeToolSet(false);
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({ text: CLAIM, calls: [{ id: 'r1', name: 'get_event', args: { event_id: 'evt-1' } }] })
        : replyStream({ text: 'Anything else I can do?' });
    });
    const delivered = deliveredText(await drain(makeThread({ toolSet, create })));
    expect(delivered).toContain(CLAIM);
    expect(delivered.endsWith(NOTE)).toBe(true);
  });

  it('adds the note when the claim and its failed write came in an early step', async () => {
    const toolSet = makeToolSet(true);
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({ text: CLAIM, calls: [{ id: 'w1', name: 'create_event', args: { title: 'Dentist' } }] })
        : replyStream({ text: 'Anything else I can do?' });
    });
    const delivered = deliveredText(await drain(makeThread({ toolSet, create })));
    expect(delivered.endsWith(NOTE)).toBe(true);
  });

  it('adds no note when a later step in the turn does the work the early claim named', async () => {
    const toolSet = makeToolSet(false);
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({ text: CLAIM, calls: [{ id: 'r1', name: 'get_event', args: { event_id: 'evt-1' } }] });
      }
      if (round === 2) {
        return replyStream({ calls: [{ id: 'w1', name: 'create_event', args: { title: 'Dentist' } }] });
      }
      return replyStream({ text: 'All done.' });
    });
    const delivered = deliveredText(await drain(makeThread({ toolSet, create })));
    expect(delivered).not.toContain('Nothing was changed yet');
  });
});

describe('repetition stop logging', () => {
  it('logs the stop with the guard and channel that made it', async () => {
    const logger = makeSilentLogger();
    const info = jest.spyOn(logger, 'info');
    const toolSet = makeToolSet(false);
    const create = jest.fn((_request: LLMCreateParamsStreaming) =>
      replyStream({ text: 'The visit is on Monday.', repetitionStopped: true }),
    );
    await drain(makeThread({ toolSet, create, logger }));
    const stopLog = info.mock.calls.find(([message]) => message === 'Stopped a reply that was repeating itself');
    expect(stopLog).toBeDefined();
    expect(stopLog?.[1]).toMatchObject({ guard: 'answer_units', channel: 'answer' });
  });
});
