import { APICallError } from 'ai';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { isRetryableProviderError } from '../../../src/core/llm/VercelAILLM';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import {
  AgentThread,
  FORCED_ANSWER_RETRY_BACKOFF_MS,
  MODEL_SERVICE_UNAVAILABLE_MESSAGE,
} from '../../../src/core/runtime/AgentThread';
import type { InternalThreadDoneEvent } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { DEFAULT_REPLY_STEP_BUDGET } from '../../../src/core/runtime/replyBudget';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

/** The error the stream mapping raises for a definite provider answer: a plain Error over the SDK's APICallError. */
function providerError(statusCode: number): Error {
  const cause = new APICallError({
    message: 'Unable to process request. Repeat the request later.',
    url: 'https://model.example/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
  });
  return new Error(`Request failed (${String(statusCode)}): ${cause.message}`, { cause });
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* failingStream(
  error: Error,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  throw error;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* lookupCallStream(
  step: number,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: `lookup-${String(step)}`,
    type: 'function' as const,
    function: { name: 'lookup', arguments: JSON.stringify({ q: step }) },
  };
  yield {
    id: `chunk-${String(step)}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

function makeLookupToolSet(): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'workspace',
    preload: true,
    tools: [{ name: 'lookup', description: 'Look something up', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
    }),
  );
  jest.mocked(toolSet.callTool).mockResolvedValue(toolResultResponse({ text: 'found' }));
  return toolSet;
}

/**
 * A model that spends its whole step budget on lookups, then answers the forced step as
 * `forcedAnswers` scripts it, one entry per attempt of that step.
 */
async function runForcedAnswer(
  forcedAnswers: (() => AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>)[],
): Promise<{ requests: LLMCreateParamsStreaming[]; doneEvent: InternalThreadDoneEvent | undefined }> {
  const requests: LLMCreateParamsStreaming[] = [];
  const create = jest.fn((request: LLMCreateParamsStreaming) => {
    requests.push(request);
    if (requests.length <= DEFAULT_REPLY_STEP_BUDGET.main) {
      return lookupCallStream(requests.length);
    }
    const attempt = forcedAnswers[requests.length - DEFAULT_REPLY_STEP_BUDGET.main - 1];
    if (attempt === undefined) {
      throw new Error('The forced answer was asked for more times than the test scripted.');
    }
    return attempt();
  });
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    isRequestContinuation: undefined,
    taskState: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [makeLookupToolSet()],
    },
    context: [{ role: 'user', content: 'Write my morning brief' }],
    // Short waits so the test runs fast; the default waits are checked separately.
    forcedAnswerRetryBackoffMs: FORCED_ANSWER_RETRY_BACKOFF_MS.map(() => 5),
  });
  let doneEvent: InternalThreadDoneEvent | undefined;
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    if (event.type === InternalEventType.AGENT_DONE) {
      doneEvent = event;
    }
  }
  return { requests, doneEvent };
}

describe('forced answer provider retry', () => {
  it('waits about 2 s, then 5 s: two retries by default', () => {
    expect(FORCED_ANSWER_RETRY_BACKOFF_MS).toEqual([2_000, 5_000]);
  });

  it('a 500 on the forced answer is retried after a short wait, and the retry answers from the gathered steps', async () => {
    const { requests, doneEvent } = await runForcedAnswer([
      () => failingStream(providerError(500)),
      () => finalAnswerStream('Here is your brief.'),
    ]);

    expect(requests).toHaveLength(DEFAULT_REPLY_STEP_BUDGET.main + 2);
    // Both forced attempts ask with no tools and the same gathered history.
    const [first, retry] = requests.slice(DEFAULT_REPLY_STEP_BUDGET.main);
    expect(first?.tools).toBeUndefined();
    expect(retry?.tools).toBeUndefined();
    expect(retry?.messages).toEqual(first?.messages);
    expect(doneEvent?.status).toBe('done');
    expect(JSON.stringify(doneEvent)).toContain('Here is your brief.');
  });

  it('three failures in a row end the reply with a message a person can act on', async () => {
    const { requests, doneEvent } = await runForcedAnswer([
      () => failingStream(providerError(500)),
      () => failingStream(providerError(503)),
      () => failingStream(providerError(429)),
    ]);

    expect(requests).toHaveLength(DEFAULT_REPLY_STEP_BUDGET.main + 3);
    expect(doneEvent?.status).toBe('error');
    expect(doneEvent?.status === 'error' ? doneEvent.error : undefined).toBe(MODEL_SERVICE_UNAVAILABLE_MESSAGE);
    expect(doneEvent?.handoff_cause).toBe('model_stream_fault');
  });

  it('a 400 on the forced answer is not retried', async () => {
    const { requests, doneEvent } = await runForcedAnswer([() => failingStream(providerError(400))]);

    expect(requests).toHaveLength(DEFAULT_REPLY_STEP_BUDGET.main + 1);
    expect(doneEvent?.status).toBe('error');
    expect(doneEvent?.handoff_cause).toBe('fatal_error');
  });

  it('counts only a "try again later" answer as retryable', () => {
    expect(isRetryableProviderError(providerError(500))).toBe(true);
    expect(isRetryableProviderError(providerError(429))).toBe(true);
    expect(isRetryableProviderError(providerError(400))).toBe(false);
    expect(isRetryableProviderError(providerError(401))).toBe(false);
    expect(isRetryableProviderError(new Error('something else'))).toBe(false);
    expect(isRetryableProviderError({ data: { code: 503 } })).toBe(true);
    expect(isRetryableProviderError({ data: { code: 404 } })).toBe(false);
  });
});
