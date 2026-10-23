/**
 * A typical reply reaches the tool it needs on its first model call. Every built-in tool is sent from
 * the start, so a scripted model that never loads anything calls the tool straight away, and the reply
 * takes one model call to the tool and one to answer. A tool missing from the first request fails here.
 */
import { AgentThread, EventType } from '@truefoundry/trueforge-core/core';
import type { ILLM, LLMCreateParamsStreaming } from '@truefoundry/trueforge-core/core/llm/ILLM';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';
import { buildPersonalInstance } from '../../../../src/runtime/promptReport/personalInstance';

interface ReplyCase {
  message: string;
  tool: string;
  args: Record<string, unknown>;
  /** The person approves the card the call raises. */
  approves: boolean;
}

const CASES: Record<string, ReplyCase> = {
  'what time is it': { message: 'What time is it?', tool: 'get_current_datetime', args: {}, approves: false },
  'a calendar question': {
    message: 'What have I got on the 5th',
    tool: 'list_events',
    args: { time_min: '2026-11-05', time_max: '2026-11-05' },
    approves: false,
  },
  'a web question': {
    message: 'Tell me the latest on the Lisbon metro strike',
    tool: 'tavily_search',
    args: { query: 'Lisbon metro strike' },
    approves: false,
  },
  'a draft request': {
    message: 'Write to grace@example.com that the lease looks fine.',
    tool: 'draft_email',
    args: { to: ['grace@example.com'], subject: 'Lease', body: 'The lease looks fine.' },
    approves: true,
  },
};

const MOST_MODEL_CALLS_TO_TOOL = 1;

function sentNames(request: LLMCreateParamsStreaming): string[] {
  return (request.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.function.name] : []));
}

async function* toolCall(input: {
  name: string;
  args: Record<string, unknown>;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await Promise.resolve();
  const call = {
    id: 'call-1',
    type: 'function' as const,
    function: { name: input.name, arguments: JSON.stringify(input.args) },
  };
  yield {
    id: 'chunk-call',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

async function* answer(
  text: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await Promise.resolve();
  yield {
    id: 'chunk-answer',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: text }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

/** Runs one reply with a model that calls the case's tool when it is sent, never loading anything first. */
async function runReply(replyCase: ReplyCase) {
  const instance = await buildPersonalInstance({
    name: 'personal-with-google',
    googleAccess: 'read_and_write',
    sentinelServices: undefined,
  });
  const requests: LLMCreateParamsStreaming[] = [];
  // The model call, counted from one, that called the case's tool.
  let callsToTool = 0;
  const modelClient: ILLM = {
    create: jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      const answered = request.messages.some(message => message.role === 'tool');
      if (answered) {
        return answer('Here is what I found.');
      }
      if (!sentNames(request).includes(replyCase.tool)) {
        return answer('I have no tool for that.');
      }
      callsToTool = requests.length;
      return toolCall({ name: replyCase.tool, args: replyCase.args });
    }),
    createNonStream: jest.fn(),
  };
  const thread = new AgentThread({
    definition: { ...instance.definition, modelClient },
    threadId: 'main',
    title: 'Main',
    turnToolCallLedger: undefined,
    sandbox: instance.sandbox,
    capabilities: instance.capabilities,
    context: [{ role: 'user', content: replyCase.message }],
    capabilityState: undefined,
    sentinel: instance.sentinel,
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: createLogger({ silent: true }),
  });
  let cards = 0;
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    if (event.type === EventType.TOOL_APPROVAL_REQUIRED) {
      cards += 1;
    }
  }
  if (replyCase.approves && cards > 0) {
    for await (const event of thread.send([
      { type: EventType.USER_TOOL_APPROVAL, thread_id: 'main', tool_call_id: 'call-1', approval: { status: 'allow' } },
    ])) {
      void event;
    }
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      void event;
    }
  }
  return { requests, cards, callsToTool };
}

describe('a typical reply reaches its tool on the first model call', () => {
  beforeAll(() => {
    // No test may reach Google or the search provider: every outbound request fails at once.
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in tests.'));
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it.each(Object.entries(CASES))('%s', async (_name, replyCase) => {
    const { requests, cards, callsToTool } = await runReply(replyCase);

    expect(callsToTool).toBe(MOST_MODEL_CALLS_TO_TOOL);
    // One call to the tool, one to answer; the draft waits on its card in between.
    expect(requests).toHaveLength(2);
    expect(cards > 0).toBe(replyCase.approves);
    for (const request of requests) {
      expect(
        request.messages
          .flatMap(message => (message.role === 'assistant' ? (message.tool_calls ?? []) : []))
          .map(call => (call.type === 'function' ? call.function.name : call.type)),
      ).not.toContain('load_bundle');
    }
  });

  it('sends the same tools whatever the message asks for', async () => {
    const lists = await Promise.all(
      Object.values(CASES).map(async replyCase => {
        const { requests } = await runReply(replyCase);
        return requests.map(request => JSON.stringify(request.tools ?? []));
      }),
    );
    expect(new Set(lists.flat()).size).toBe(1);
  });
});
