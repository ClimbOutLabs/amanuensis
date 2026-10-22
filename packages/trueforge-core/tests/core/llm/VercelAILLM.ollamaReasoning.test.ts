/**
 * Ollama serves a Qwen3-based model over its OpenAI-compatible `/v1` endpoint and streams the
 * thinking as a top-level `reasoning` delta field, not the `reasoning_content` field vLLM and
 * DeepSeek use. These tests guard the pieces end to end, through a mocked SSE fetch:
 *  1. a `reasoning` delta/message field is treated exactly like `reasoning_content`.
 *  2. a turn that finishes `stop`, empty (or whitespace-only) content, and non-empty reasoning
 *     never persists a silent or reasoning-leaking empty assistant message: the host asks for one
 *     more step instead, and only falls back to a fixed host note if that second step is also
 *     empty.
 *  3. the reasoning from the first, empty step is never replayed to the model twice (once as
 *     `thinking_blocks`, once copied into visible `content`).
 */
import { VercelAILLM } from '../../../src/core/llm/VercelAILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

interface Frame {
  delta: Record<string, unknown>;
  finishReason: 'stop' | null;
}

function isAgentDoneEvent(
  event: AgentThreadEvent,
): event is Extract<AgentThreadEvent, { type: typeof InternalEventType.AGENT_DONE }> {
  return event.type === InternalEventType.AGENT_DONE;
}

function sseBodyFor(frames: Frame[]): string {
  const body = frames
    .map(
      frame =>
        `data: ${JSON.stringify({
          id: 'ollama-synthetic',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'qwen3',
          choices: [{ index: 0, delta: frame.delta, finish_reason: frame.finishReason }],
        })}\n\n`,
    )
    .join('');
  return `${body}data: [DONE]\n\n`;
}

/**
 * Mocks `fetch` to return one SSE response per call, taken in order from `callFrames` (extra
 * calls beyond the array reuse the last entry). Records every request body seen so tests can
 * inspect what was actually replayed to the model.
 */
function mockOllamaProvider(callFrames: Frame[][]): { requestBodies: string[] } {
  const requestBodies: string[] = [];
  let callCount = 0;
  jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    requestBodies.push(body);
    const frames = callFrames[Math.min(callCount, callFrames.length - 1)] ?? [];
    callCount += 1;
    return Promise.resolve(
      new Response(sseBodyFor(frames), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  });
  return { requestBodies };
}

function modelClient(): VercelAILLM {
  return new VercelAILLM({
    logger: makeSilentLogger(),
    providerConfig: {
      provider: { type: 'custom' as const, name: 'ollama' },
      model: { id: 'qwen3', name: 'qwen3' },
      name: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'not-needed',
      headers: {},
    },
  });
}

async function runThread(userText: string): Promise<AgentThreadEvent[]> {
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Ollama empty-answer turn',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelId: undefined,
      configuredModels: undefined,
      modelClient: modelClient(),
      toolSets: [],
    },
    context: [{ role: 'user', content: userText }],
  });
  const events: AgentThreadEvent[] = [];
  for await (const event of thread.execute({})) events.push(event);
  return events;
}

describe('Ollama-style `reasoning` field (openai-compatible provider)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('maps a `reasoning` delta the same way as `reasoning_content`', async () => {
    mockOllamaProvider([
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { reasoning: 'Weighing the options.' }, finishReason: null },
        { delta: { content: 'Here is the answer.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
    ]);
    const result = await modelClient().createNonStream({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(result.finish_reason).toBe('stop');
    expect(result.output.content).toBe('Here is the answer.');
    expect(result.output.thinking_blocks).toMatchObject([{ type: 'thinking', thinking: 'Weighing the options.' }]);
  });

  it('nudges for one more step, and accepts the second answer, when content is empty and reasoning is not', async () => {
    mockOllamaProvider([
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { reasoning: 'Thinking through a sensitive question carefully.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { content: 'Here is my actual answer.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
    ]);
    const events = await runThread('A sensitive question.');

    const done = events.find(isAgentDoneEvent);
    expect(done).toBeDefined();
    expect(done?.status).toBe('done');
    const content = done?.status === 'done' ? done.output.content : undefined;
    expect(content).toBe('Here is my actual answer.');
    expect(content).not.toContain('Thinking through a sensitive question carefully.');
  });

  it('treats whitespace-only content as empty and nudges for a real answer', async () => {
    mockOllamaProvider([
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { reasoning: 'Whitespace is not an answer.' }, finishReason: null },
        { delta: { content: '   \n\t  ' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { content: 'A real answer this time.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
    ]);
    const events = await runThread('Another question.');

    const done = events.find(isAgentDoneEvent);
    expect(done?.status).toBe('done');
    const content = done?.status === 'done' ? done.output.content : undefined;
    expect(content).toBe('A real answer this time.');
  });

  it('triggers the nudge from thinking_blocks-only reasoning (no reasoning_content survives to the final message)', async () => {
    const { requestBodies } = mockOllamaProvider([
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { reasoning: 'Only structured thinking, nothing else.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { content: 'Answer after the nudge.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
    ]);
    const events = await runThread('Third question.');

    const done = events.find(isAgentDoneEvent);
    expect(done?.status).toBe('done');
    const content = done?.status === 'done' ? done.output.content : undefined;
    expect(content).toBe('Answer after the nudge.');
    // A second model call happened at all, which only occurs if the nudge fired.
    expect(requestBodies.length).toBe(2);
  });

  it("does not replay the empty step's reasoning twice on the next request", async () => {
    const { requestBodies } = mockOllamaProvider([
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { reasoning: 'Reasoning that must not be duplicated.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { content: 'Final answer.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
    ]);
    await runThread('Fourth question.');

    expect(requestBodies.length).toBe(2);
    const secondBody = requestBodies[1] ?? '{}';
    const parsedSecondBody: unknown = JSON.parse(secondBody);
    if (typeof parsedSecondBody !== 'object' || parsedSecondBody === null || !('messages' in parsedSecondBody)) {
      throw new Error(`expected the second request body to be an object with a "messages" field, got: ${secondBody}`);
    }
    const messages = (parsedSecondBody as { messages: unknown }).messages;
    if (!Array.isArray(messages)) {
      throw new Error(`expected the second request body's "messages" field to be an array, got: ${secondBody}`);
    }
    const secondRequest = { messages: messages as Array<Record<string, unknown>> };
    const occurrences = (secondBody.match(/Reasoning that must not be duplicated\./g) ?? []).length;
    // Never duplicated: the bug this guards copied the reasoning into visible `content` while also
    // leaving it in `thinking_blocks`, so the same text rode along twice (once as an ordinary
    // message, once as replayed reasoning). At most one copy may appear.
    expect(occurrences).toBeLessThanOrEqual(1);
    // Specifically: no assistant message in the replayed request carries the reasoning text as
    // ordinary visible `content` (the exact shape of the fixed bug).
    const contentLeak = secondRequest.messages.some(
      m =>
        m['role'] === 'assistant' &&
        typeof m['content'] === 'string' &&
        (m['content'] as string).includes('Reasoning that must not be duplicated.'),
    );
    expect(contentLeak).toBe(false);
  });

  it('persists a fixed host note, not the reasoning, when the second answer is also empty', async () => {
    mockOllamaProvider([
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { reasoning: 'First attempt reasoning.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
      [
        { delta: { role: 'assistant' }, finishReason: null },
        { delta: { reasoning: 'Second attempt reasoning, still no answer.' }, finishReason: null },
        { delta: {}, finishReason: 'stop' },
      ],
    ]);
    const events = await runThread('Fifth question.');

    const done = events.find(isAgentDoneEvent);
    expect(done?.status).toBe('done');
    const content = done?.status === 'done' ? done.output.content : undefined;
    expect(content).toBe('The model produced no answer.');
    expect(content).not.toContain('First attempt reasoning.');
    expect(content).not.toContain('Second attempt reasoning, still no answer.');
  });
});
