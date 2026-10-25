/**
 * SCRATCH PROBES for symptom 3 (early done claims) at the AgentThread level.
 * Mirrors the harness in fakeToolCalls.test.ts. Logs observed outcomes.
 */
import { appendFileSync } from 'node:fs';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
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
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

function note(text: string): void {
  appendFileSync('/home/hatch/workspace/job-runaway-replies/probe-results2.txt', `${text}\n`);
}

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
  };
}

function makeThread(input: { toolSet: IToolSet; create: ILLM['create'] }) {
  return new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
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
    .map(event =>
      typeof event === 'object' && event !== null && 'type' in event && event.type === EventType.MODEL_MESSAGE_DELTA
        ? (event as { content?: unknown }).content
        : undefined,
    )
    .filter((content): content is string => typeof content === 'string')
    .join('');
}

describe('probes: symptom 3, claims in early steps', () => {
  it('C1 claim in step 1 with only a read call in the turn, bland final step', async () => {
    const toolSet = makeToolSet(false);
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({
            text: "I've set the reminder for 9:10.",
            calls: [{ id: 'r1', name: 'get_event', args: { event_id: 'evt-1' } }],
          })
        : replyStream({ text: 'Anything else I can do?' });
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    note(`C1 delivered: ${JSON.stringify(deliveredText(events))}`);
  });

  it('C2 claim in step 1, the matching write succeeds in step 2, bland final step', async () => {
    const toolSet = makeToolSet(false);
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      if (round === 1) {
        return replyStream({
          text: "I've set the reminder for 9:10.",
          calls: [{ id: 'r1', name: 'get_event', args: { event_id: 'evt-1' } }],
        });
      }
      if (round === 2) {
        return replyStream({ calls: [{ id: 'c1', name: 'create_event', args: { title: 'Reminder' } }] });
      }
      return replyStream({ text: 'All done.' });
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    note(`C2 delivered: ${JSON.stringify(deliveredText(events))}`);
  });

  it('C3 the matching write fails, claim in the final step (control)', async () => {
    const toolSet = makeToolSet(true);
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({ calls: [{ id: 'c1', name: 'create_event', args: { title: 'Reminder' } }] })
        : replyStream({ text: "I've set the reminder for 9:10." });
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    note(`C3 delivered: ${JSON.stringify(deliveredText(events))}`);
  });

  it('C4 claim in step 1, the matching write fails in step 1, bland final step', async () => {
    const toolSet = makeToolSet(true);
    let round = 0;
    const create = jest.fn((_request: LLMCreateParamsStreaming) => {
      round += 1;
      return round === 1
        ? replyStream({
            text: "I've set the reminder for 9:10.",
            calls: [{ id: 'c1', name: 'create_event', args: { title: 'Reminder' } }],
          })
        : replyStream({ text: 'Anything else I can do?' });
    });
    const thread = makeThread({ toolSet, create });
    const events = await drain(thread);
    note(`C4 delivered: ${JSON.stringify(deliveredText(events))}`);
  });
});
