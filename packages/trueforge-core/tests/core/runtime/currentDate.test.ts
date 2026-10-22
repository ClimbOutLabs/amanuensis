import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import '../harnessMocks';
import { makeSilentLogger } from '../harnessMocks';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };

  return {
    output: { role: 'assistant', content: 'done' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function makeThread(modelClient: ILLM, modelId?: string, clientTimezone?: string): AgentThread {
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
      modelClient,
      modelId,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [],
      clientTimezone,
    },
    context: [{ role: 'user', content: 'hi' }],
  });
}

describe('AgentThread ambient current date', () => {
  beforeEach(() => {
    // Fake only Date: real timers and microtasks keep async draining alive,
    // while the pinned clock makes the expected date deterministic instead of
    // racing a live UTC-midnight rollover.
    jest.useFakeTimers({
      now: new Date('2026-03-14T18:00:00Z'),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("puts today's UTC date in the per-reply block and never in the static instruction", async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    const thread = makeThread(modelClient);
    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(
      m => m.role === 'system' && String(m.content).includes('<reply-context>'),
    );
    const staticInstruction = request?.messages.find(m => m.role === 'system');
    expect(String(staticInstruction?.content)).not.toContain('Today');
    expect(systemMessage?.content).toContain('<current-date>');
    expect(systemMessage?.content).toContain("Today's date is 2026-03-14 (UTC)");
    // Date only: a time-of-day component would change the prompt prefix every
    // turn and defeat provider prefix caching.
    expect(systemMessage?.content).not.toMatch(/Today's date is [^<]*\d{2}:\d{2}/);
  });

  it("adds the user's local date and zone when clientTimezone is set", async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    // 2026-03-14T18:00:00Z is 2026-03-14 11:00 in Los Angeles (UTC-7, PDT).
    const thread = makeThread(modelClient, undefined, 'America/Los_Angeles');
    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(
      m => m.role === 'system' && String(m.content).includes('<reply-context>'),
    );
    expect(systemMessage?.content).toContain("Today's date is 2026-03-14 (UTC)");
    expect(systemMessage?.content).toContain("The user's local date is 2026-03-14 (America/Los_Angeles, UTC-07:00)");
  });

  it('falls back to UTC-only wording for an unrecognized clientTimezone', async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    const thread = makeThread(modelClient, undefined, 'Not/A_Zone');
    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(
      m => m.role === 'system' && String(m.content).includes('<reply-context>'),
    );
    expect(systemMessage?.content).toContain("Today's date is 2026-03-14 (UTC)");
    expect(systemMessage?.content).not.toContain("The user's local date is");
  });

  it('keeps the date the reply started with when the reply crosses UTC midnight', async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    // Construct just before midnight: the per-reply block is built once, when the reply starts,
    // so a later step past the rollover still sends the reply's date (one fixed block per reply).
    jest.setSystemTime(new Date('2026-03-14T23:59:59Z'));
    const thread = makeThread(modelClient);
    jest.setSystemTime(new Date('2026-03-15T00:00:05Z'));

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(
      m => m.role === 'system' && String(m.content).includes('<reply-context>'),
    );
    expect(systemMessage?.content).toContain("Today's date is 2026-03-14 (UTC)");
  });
});

describe('AgentThread model self-identity', () => {
  it('tells the model its own resolved upstream id verbatim, slash and all', async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    // A Hugging Face style "org/model" id served by vLLM is a valid upstream
    // identifier in its own right, and the slash is not a catalog separator
    // here, so AgentThread must never strip it.
    const thread = makeThread(modelClient, 'meta-llama/Llama-3.1-70B-Instruct');
    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(m => m.role === 'system');
    expect(systemMessage?.content).toContain('<model-identity>');
    expect(systemMessage?.content).toContain('You are running as the model "meta-llama/Llama-3.1-70B-Instruct"');
  });

  it('tells the model the catalog FQN provider prefix already stripped by the fallback resolver', async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    // TurnResourceResolver strips the provider prefix off its fallback catalog
    // FQN (provider/name) before it ever reaches definition.modelId, so
    // AgentThread receives an already-stripped id here and renders it as-is.
    const thread = makeThread(modelClient, 'qwen-3-6-35b-a-3b-abliterated-fp-8-dynamic');
    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(m => m.role === 'system');
    expect(systemMessage?.content).toContain('<model-identity>');
    expect(systemMessage?.content).toContain(
      'You are running as the model "qwen-3-6-35b-a-3b-abliterated-fp-8-dynamic"',
    );
  });

  it('omits the model-identity section when no model id is configured', async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    const thread = makeThread(modelClient);
    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(m => m.role === 'system');
    expect(systemMessage?.content).not.toContain('<model-identity>');
  });
});
