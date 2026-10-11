import type {
  AgentContextProcessorCompactionEvent,
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
} from '../../../../src/core/capabilities/AgentContextProcessor';
import {
  contextCompaction,
  CONVERSATION_REQUIRED_SUMMARY_SECTIONS,
} from '../../../../src/core/capabilities/builtins/ContextCompaction';
import { EventType } from '../../../../src/core/events/schema';
import type { ILLM, LLMCreateParams } from '../../../../src/core/llm/ILLM';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type InternalEnrichedToolCall,
  type InternalToolCallInfo,
  type RawAssistantMessageWithUsage,
} from '../../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../../src/core/runtime/AgentThread';
import { InternalEventType, type ContextMessage } from '../../../../src/core/runtime/AgentThread.types';
import { estimateTokensForContextMessages } from '../../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeMockILLM, makeSilentLogger } from '../../harnessMocks';

const USAGE = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const TRUNCATION_MARKER = 'characters truncated by host';

function conversationSummary(facts: string): string {
  const bodies: Record<(typeof CONVERSATION_REQUIRED_SUMMARY_SECTIONS)[number], string> = {
    user_goal: 'Help the user plan the migration.',
    facts_established: facts,
    answers_given: 'none',
    open_questions: 'none',
    user_preferences_and_constraints: 'none',
    last_request: 'Continue the migration plan.',
  };
  return `<summary>\n${CONVERSATION_REQUIRED_SUMMARY_SECTIONS.map(name => `## ${name}\n${bodies[name]}`).join('\n\n')}\n</summary>`;
}

/** A summarizer stand-in that remembers exactly the facts it can see in the transcript it was given. */
function transcriptFaithfulSummarizer(facts: readonly string[]) {
  return jest.fn((body: LLMCreateParams) => {
    const transcript = String(body.messages[1]?.content);
    const seen = facts.filter(fact => transcript.includes(fact));
    return Promise.resolve({
      output: { role: 'assistant' as const, content: conversationSummary(seen.join('; ') || 'none') },
      usage: USAGE,
      finish_reason: 'stop' as const,
    });
  });
}

function makeCapability(input: {
  createNonStream: ILLM['createNonStream'];
  thresholdTokens?: number;
  contextLength?: number;
  logger?: ReturnType<typeof makeSilentLogger>;
}) {
  return contextCompaction({
    logger: input.logger,
    definition: {
      modelId: undefined,
      configuredModels: undefined,
      modelClient: makeMockILLM({ createNonStream: input.createNonStream }),
      ...(input.contextLength === undefined ? {} : { modelProperties: { contextLength: input.contextLength } }),
    },
    compactionThresholdTokens: input.thresholdTokens ?? 1,
  });
}

async function collect(
  capability: ReturnType<typeof contextCompaction>,
  context: ContextMessage[],
  options: { promptTokens?: number } = {},
): Promise<AgentContextProcessorOutput[]> {
  const processor = capability.preLLMProcessors?.[0];
  if (processor === undefined) {
    throw new Error('expected a preLLMProcessor');
  }
  const execution: AgentThreadExecutionContext = {
    threadId: 'main',
    signal: undefined,
    currentContextUsage: { prompt_tokens: options.promptTokens ?? 0, completion_tokens: 0 },
    context,
  };
  const events: AgentContextProcessorOutput[] = [];
  for await (const event of processor.processPreLLM(execution)) {
    events.push(event);
  }
  return events;
}

function overwriteContext(events: readonly AgentContextProcessorOutput[]): ContextMessage[] {
  for (const event of events) {
    if (event.type === EventType.AGENT_CONTEXT_OVERWRITE) {
      return event.context;
    }
  }
  throw new Error('expected an overwrite event');
}

function overwriteReason(events: readonly AgentContextProcessorOutput[]): string {
  for (const event of events) {
    if (event.type === EventType.AGENT_CONTEXT_OVERWRITE) {
      return event.reason;
    }
  }
  throw new Error('expected an overwrite event');
}

function compactionEvent(events: readonly AgentContextProcessorOutput[]): AgentContextProcessorCompactionEvent {
  for (const event of events) {
    if (event.type === EventType.AGENT_CONTEXT_COMPACTION) {
      return event;
    }
  }
  throw new Error('expected a compaction event');
}

/** The transcript the summarizer was shown on call `callIndex`. */
function requestTranscript(createNonStream: jest.Mock, callIndex = 0): string {
  const call: unknown = createNonStream.mock.calls[callIndex]?.[0];
  if (typeof call !== 'object' || call === null || !('messages' in call) || !Array.isArray(call.messages)) {
    throw new Error('expected a summarizer request');
  }
  return String(call.messages[1]?.content);
}

function requestChars(createNonStream: jest.Mock): number {
  const call: unknown = createNonStream.mock.calls[0]?.[0];
  if (typeof call !== 'object' || call === null || !('messages' in call) || !Array.isArray(call.messages)) {
    throw new Error('expected a summarizer request');
  }
  return call.messages.reduce((sum: number, message: { content: unknown }) => sum + String(message.content).length, 0);
}

function turns(prefix: string, count: number, size = 300): ContextMessage[] {
  const messages: ContextMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(
      { role: 'user', content: `${prefix} question ${String(i)} ${'q'.repeat(size)}` },
      { role: 'assistant', content: `${prefix} answer ${String(i)} ${'a'.repeat(size)}` },
    );
  }
  return messages;
}

function toolCall(input: { id: string; name: string; args: string }): InternalEnrichedToolCall {
  const toolInfo: InternalToolCallInfo = {
    type: 'truefoundry-system',
    mcp_server_id: 'srv',
    mcp_server_name: 'Srv',
    original_tool_name: input.name,
    is_approval_required: false,
    effect: 'inspect',
  };
  return { id: input.id, type: 'function', function: { name: input.name, arguments: input.args }, tool_info: toolInfo };
}

describe('repeated compaction keeps the earlier summary', () => {
  const FACT = 'the staging database is named ZEBRA-742';

  async function firstCompaction() {
    const createNonStream = transcriptFaithfulSummarizer([FACT]);
    const events = await collect(makeCapability({ createNonStream }), [
      { role: 'user', content: `Remember: ${FACT}.` },
      { role: 'assistant', content: 'Noted.' },
      ...turns('early', 4),
    ]);
    return { context: overwriteContext(events), events };
  }

  it('includes the previous summary in the next summarization transcript', async () => {
    const first = await firstCompaction();
    expect(compactionEvent(first.events).outcome).toBe('applied');

    const createNonStream = transcriptFaithfulSummarizer([FACT]);
    const second = await collect(makeCapability({ createNonStream }), [...first.context, ...turns('later', 4)]);

    expect(requestTranscript(createNonStream)).toContain('<prior-summary>');
    expect(compactionEvent(second).outcome).toBe('applied');
    // The fact lives only in the first summary; it survives because the second summary carried it forward.
    expect(JSON.stringify(overwriteContext(second))).toContain(FACT);
  });

  it('keeps the latest summary when the truncation fallback runs after a compaction', async () => {
    const first = await firstCompaction();

    const failing = jest.fn().mockResolvedValue({
      output: { role: 'assistant', content: 'not a summary' },
      usage: USAGE,
      finish_reason: 'stop',
    });
    const second = await collect(makeCapability({ createNonStream: failing }), [
      ...first.context,
      ...turns('later', 4),
    ]);

    expect(overwriteReason(second)).toBe('compaction_truncation_fallback');
    expect(compactionEvent(second).outcome).toBe('truncated_fallback');
    const persisted = JSON.stringify(overwriteContext(second));
    expect(persisted).toContain(FACT);
    expect(persisted.split('host-written summary').length - 1).toBe(1);
  });

  it('keeps the same summary through consecutive truncation fallbacks', async () => {
    const first = await firstCompaction();
    const failing = jest.fn().mockRejectedValue(new Error('provider down'));

    const second = await collect(makeCapability({ createNonStream: failing }), [...first.context, ...turns('mid', 4)]);
    const third = await collect(makeCapability({ createNonStream: failing }), [
      ...overwriteContext(second),
      ...turns('late', 4),
    ]);

    const persisted = JSON.stringify(overwriteContext(third));
    expect(persisted).toContain(FACT);
    expect(persisted.split('host-written summary').length - 1).toBe(1);
  });
});

describe('summarization transcript tool calls', () => {
  function toolContext(args: string): ContextMessage[] {
    return [
      { role: 'user', content: 'Look up the release notes.' },
      {
        role: 'assistant',
        content: 'Searching.',
        tool_calls: [toolCall({ id: 'call-1', name: 'web_search', args })],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'RESULT-XYZ release 4.2 shipped' },
      ...turns('after', 4),
    ];
  }

  it('lists each tool call by name with compact arguments, paired with its result', async () => {
    const createNonStream = transcriptFaithfulSummarizer([]);
    await collect(makeCapability({ createNonStream }), toolContext('{\n  "query":   "release notes"\n}'));

    const transcript = requestTranscript(createNonStream);
    expect(transcript).toContain('<tool-call id=call-1 name=web_search>{"query":"release notes"}</tool-call>');
    expect(transcript).toContain('<tool-response id=call-1 name=web_search>:RESULT-XYZ release 4.2 shipped');
  });

  it('truncates oversized tool-call arguments and marks the cut', async () => {
    const createNonStream = transcriptFaithfulSummarizer([]);
    await collect(
      makeCapability({ createNonStream }),
      toolContext(JSON.stringify({ path: 'big.txt', content: 'z'.repeat(20_000) })),
    );

    const transcript = requestTranscript(createNonStream);
    expect(transcript).toContain('<tool-call id=call-1 name=web_search>{"path":"big.txt"');
    expect(transcript).toContain(TRUNCATION_MARKER);
    expect(transcript).not.toContain('z'.repeat(1_000));
  });
});

describe('failing summarizer', () => {
  it('falls back to truncation instead of failing the turn when the summarizer call throws', async () => {
    const createNonStream = jest.fn().mockRejectedValue(new Error('provider 500: request echo SECRET-TOKEN'));
    const logger = makeSilentLogger();
    const warn = jest.spyOn(logger, 'warn');
    const context = [...turns('old', 6), { role: 'user' as const, content: 'The newest question' }];

    const events = await collect(makeCapability({ createNonStream, logger }), context);

    expect(overwriteReason(events)).toBe('compaction_truncation_fallback');
    const event = compactionEvent(events);
    expect(event.outcome).toBe('truncated_fallback');
    expect(event.reason).toBe('summarizer_failed');
    expect(JSON.stringify(overwriteContext(events))).toContain('The newest question');
    // No call completed, so nothing is billed.
    expect(events.some(e => e.type === InternalEventType.MODEL_USAGE)).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-TOKEN');
  });
});

describe('bounded summarizer request', () => {
  it('cuts the largest messages so the request fits the model context, marking each cut', async () => {
    const contextLength = 8_000;
    const createNonStream = transcriptFaithfulSummarizer([]);
    const context: ContextMessage[] = [
      { role: 'user', content: 'SMALL-HEAD first request' },
      ...Array.from({ length: 10 }, (_, i): ContextMessage => ({
        role: 'assistant',
        content: `${'m'.repeat(40_000)}${String(i)}`,
      })),
      ...turns('tail', 2),
    ];

    const events = await collect(makeCapability({ createNonStream, contextLength }), context);

    expect(compactionEvent(events).outcome).toBe('applied');
    expect(createNonStream).toHaveBeenCalledTimes(1);
    const transcript = requestTranscript(createNonStream);
    expect(transcript).toContain('SMALL-HEAD first request');
    expect(transcript).toContain(TRUNCATION_MARKER);
    // 4,096 output tokens and the 512-token margin come off the 8,000-token context.
    expect(requestChars(createNonStream) / 4).toBeLessThanOrEqual(contextLength - 4_096 - 512);
  });

  it('falls back without calling the summarizer when the request cannot fit even after cutting', async () => {
    const createNonStream = transcriptFaithfulSummarizer([]);
    const events = await collect(makeCapability({ createNonStream, contextLength: 5_000 }), turns('many', 200, 2_000));

    expect(createNonStream).not.toHaveBeenCalled();
    expect(overwriteReason(events)).toBe('compaction_truncation_fallback');
    const event = compactionEvent(events);
    expect(event.outcome).toBe('truncated_fallback');
    expect(event.reason).toBe('request_too_large');
  });

  it('summarizes a last message larger than the tail budget from a cut copy', async () => {
    const contextLength = 32_000;
    const createNonStream = transcriptFaithfulSummarizer([]);
    const huge = `HUGE-HEAD ${'h'.repeat(600_000)} HUGE-END`;
    const context: ContextMessage[] = [...turns('lead', 2), { role: 'user', content: huge }];

    const events = await collect(makeCapability({ createNonStream, contextLength, thresholdTokens: 10_000 }), context, {
      promptTokens: 20_000,
    });

    expect(compactionEvent(events).outcome).toBe('applied');
    const transcript = requestTranscript(createNonStream);
    expect(transcript).toContain('HUGE-HEAD');
    expect(transcript).toContain('HUGE-END');
    expect(transcript).toContain(TRUNCATION_MARKER);
    expect(transcript.length).toBeLessThan(contextLength * 4);
    // The oversized message is summarized rather than kept: only the host notes remain.
    const persisted = overwriteContext(events);
    expect(persisted).toHaveLength(2);
    expect(estimateTokensForContextMessages(persisted).prompt_tokens).toBeLessThan(2_000);
  });
});

describe('pre-flight guard with an explicit threshold above the model window', () => {
  // eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
  async function* answerStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    yield {
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
    };
    return { output: { role: 'assistant', content: 'answer' }, usage: getEmptyUsage(), finish_reason: 'stop' };
  }

  it('compacts to a context that fits instead of keeping a tail larger than the window', async () => {
    const create = jest.fn(answerStream);
    const createNonStream = transcriptFaithfulSummarizer([]);
    const modelClient = makeMockILLM({ create, createNonStream });
    const definition = {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      toolSets: [],
      modelProperties: { contextLength: 8_192 },
    };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      sandbox: undefined,
      definition,
      // ~8k tokens, over the 8,192-token window, while 50,000 is far above it.
      context: turns('big', 4, 4_000),
      capabilities: [contextCompaction({ logger: undefined, definition, compactionThresholdTokens: 50_000 })],
    });

    const events = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(createNonStream).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.type === EventType.AGENT_CONTEXT_OVERWRITE)).toBe(true);
    expect(events.some(event => event.type === InternalEventType.AGENT_DONE && event.status === 'error')).toBe(false);
  });
});
