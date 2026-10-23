import { EventType } from '../../../src/core/events/schema';
import { streamDeadlineDetailsOf } from '../../../src/core/llm/streamDeadline';
import { VercelAILLM } from '../../../src/core/llm/VercelAILLM';
import { AgentThread, MODEL_STOPPED_ANSWERING_MESSAGE } from '../../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

interface Frame {
  atMs: number;
  delta: Record<string, unknown>;
  finishReason: 'stop' | 'tool_calls' | null;
}

function mockProvider(frames: Frame[]) {
  const observed: { abortReason: unknown; heartbeats: number } = { abortReason: undefined, heartbeats: 0 };
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error('Expected abortable model request');
    const response = new ReadableStream<Uint8Array>({
      start(controller) {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const emit = (frame: Frame) => {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                id: 'synthetic-response',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'synthetic-model',
                choices: [{ index: 0, delta: frame.delta, finish_reason: frame.finishReason }],
              })}\n\n`,
            ),
          );
        };
        const heartbeat = setInterval(() => {
          observed.heartbeats += 1;
          emit({ atMs: 0, delta: {}, finishReason: null });
        }, 10);
        const cleanup = () => {
          clearInterval(heartbeat);
          for (const timer of timers) clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        };
        function onAbort() {
          observed.abortReason = signal?.reason;
          cleanup();
          controller.error(signal?.reason);
        }
        signal.addEventListener('abort', onAbort, { once: true });
        for (const frame of frames) {
          timers.push(
            setTimeout(() => {
              emit(frame);
              if (frame.finishReason !== null) {
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                cleanup();
                controller.close();
              }
            }, frame.atMs),
          );
        }
        // Bound the unfixed baseline without letting a hung test hold the suite open.
        timers.push(
          setTimeout(() => {
            cleanup();
            controller.error(new Error('Synthetic provider remained open'));
          }, 500),
        );
      },
    });
    return Promise.resolve(new Response(response, { headers: { 'content-type': 'text/event-stream' } }));
  });
  return { observed, fetchMock };
}

function modelClient(signal: AbortSignal) {
  const config = {
    signal,
    logger: makeSilentLogger(),
    streamTimeout: { firstChunkMs: 100, chunkMs: 50 },
    providerConfig: {
      provider: { type: 'custom' as const, name: 'synthetic' },
      model: { id: 'synthetic-model', name: 'synthetic-model' },
      name: 'synthetic',
      baseUrl: 'https://synthetic.invalid/v1',
      apiKey: 'synthetic-test-only',
      headers: {},
    },
  };
  return new VercelAILLM(config);
}

describe('provider stream progress deadlines', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'performance', 'hrtime'] }));
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('aborts empty heartbeats after a partial tool proposal without admission or execution', async () => {
    const { observed, fetchMock } = mockProvider([
      {
        atMs: 5,
        delta: {
          tool_calls: [
            { index: 0, id: 'partial-call', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
          ],
        },
        finishReason: null,
      },
    ]);
    const caller = new AbortController();
    const toolSet = makeMockIMCPServer({ name: 'synthetic', preload: true });
    jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: 'tool_a',
      is_approval_required: true,
    });
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Synthetic stalled tool stream',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelId: undefined,
        configuredModels: undefined,
        modelClient: modelClient(caller.signal),
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'Propose a synthetic tool call.' }],
    });
    const completion = (async () => {
      const events = [];
      for await (const event of thread.execute({ signal: caller.signal })) events.push(event);
      return events;
    })();
    await jest.advanceTimersByTimeAsync(600);
    const events = await completion;
    expect(observed.abortReason).toMatchObject({ name: 'TimeoutError' });
    expect(observed.heartbeats).toBeGreaterThan(0);
    // Both attempts were cut by the deadline (about eleven heartbeats), nowhere near the
    // hundred the provider's own 500 ms bound would have allowed across two streams.
    expect(observed.heartbeats).toBeLessThan(20);
    expect(caller.signal.aborted).toBe(false);
    // The silent step is retried once before the turn ends; the partial call never runs on either.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toolSet.callTool).not.toHaveBeenCalled();
    expect(thread.hasOpenToolCallId('partial-call')).toBe(false);
    expect(
      events.filter(event =>
        [EventType.TOOL_APPROVAL_REQUIRED, EventType.TOOL_EXECUTION_STARTED, EventType.TOOL_RESPONSE_V2].some(
          type => event.type === type,
        ),
      ),
    ).toEqual([]);
    expect(events.filter(event => event.type === InternalEventType.AGENT_DONE)).toMatchObject([
      { status: 'error', error: MODEL_STOPPED_ANSWERING_MESSAGE, handoff_cause: 'model_response_timeout' },
    ]);
  });

  it('bounds a provider that sends only empty heartbeats before its first output', async () => {
    const { observed } = mockProvider([]);
    const caller = new AbortController();
    const completion = modelClient(caller.signal)
      .createNonStream({ messages: [{ role: 'user', content: 'Hello' }] })
      .then(
        result => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
    await jest.advanceTimersByTimeAsync(600);
    const settled = await completion;
    expect(settled.error).toMatchObject({ message: expect.stringMatching(/first.*chunk.*timeout/i) });
    expect(observed.abortReason).toMatchObject({ name: 'TimeoutError' });
    expect(observed.heartbeats).toBeLessThan(12);
    // The record says plainly that nothing at all arrived before the first-chunk deadline fired.
    expect(streamDeadlineDetailsOf(settled.error)).toMatchObject({
      deadline: 'first_chunk',
      timeoutMs: 100,
      lastProgressField: null,
      msSinceLastProgress: null,
    });
  });

  it('allows continuing reasoning and text past the first-output deadline without timing out the whole turn', async () => {
    const { observed } = mockProvider([
      { atMs: 20, delta: { reasoning_content: 'Inspecting the available evidence.' }, finishReason: null },
      { atMs: 60, delta: { reasoning_content: ' Comparing the constraints.' }, finishReason: null },
      { atMs: 100, delta: { content: 'The constraints conflict.' }, finishReason: null },
      { atMs: 140, delta: {}, finishReason: 'stop' },
    ]);
    const caller = new AbortController();
    const completion = modelClient(caller.signal).createNonStream({
      messages: [{ role: 'user', content: 'Explain the conflict.' }],
    });
    await jest.advanceTimersByTimeAsync(600);
    const result = await completion;
    expect(result.finish_reason).toBe('stop');
    expect(result.output.content).toBe('The constraints conflict.');
    expect(observed.abortReason).toBeUndefined();
  });

  it('lets a provider whose reasoning arrives under a field the parser drops finish, and shows the thinking', async () => {
    const { observed } = mockProvider([
      {
        atMs: 20,
        delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Thinking about breeds.' }] },
        finishReason: null,
      },
      {
        atMs: 60,
        delta: { reasoning_details: [{ type: 'reasoning.text', text: ' Still thinking.' }] },
        finishReason: null,
      },
      {
        atMs: 100,
        delta: { reasoning_details: [{ type: 'reasoning.text', text: ' Almost there.' }] },
        finishReason: null,
      },
      {
        atMs: 140,
        delta: { reasoning_details: [{ type: 'reasoning.text', text: ' Done thinking.' }] },
        finishReason: null,
      },
      { atMs: 180, delta: { content: 'Here is the answer.' }, finishReason: null },
      { atMs: 220, delta: {}, finishReason: 'stop' },
    ]);
    const caller = new AbortController();
    const completion = modelClient(caller.signal).createNonStream({
      messages: [{ role: 'user', content: 'Name a breed.' }],
    });
    await jest.advanceTimersByTimeAsync(600);
    const result = await completion;
    expect(observed.abortReason).toBeUndefined();
    expect(result.finish_reason).toBe('stop');
    expect(result.output.content).toBe('Here is the answer.');
    const thinking = (result.output.thinking_blocks ?? []).map(block => block.thinking).join('');
    expect(thinking).toContain('Thinking about breeds.');
    expect(thinking).toContain('Done thinking.');
  });

  it('lets a tool call whose name arrives only in the last frame finish with its full arguments', async () => {
    const { observed } = mockProvider([
      {
        atMs: 5,
        delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { arguments: '{"body":"<div>' } }] },
        finishReason: null,
      },
      {
        atMs: 45,
        delta: { tool_calls: [{ index: 0, function: { arguments: ' <p>card one</p>' } }] },
        finishReason: null,
      },
      {
        atMs: 85,
        delta: { tool_calls: [{ index: 0, function: { arguments: ' <p>card two</p>' } }] },
        finishReason: null,
      },
      {
        atMs: 125,
        delta: { tool_calls: [{ index: 0, function: { arguments: ' </div>"}' } }] },
        finishReason: null,
      },
      {
        atMs: 165,
        delta: { tool_calls: [{ index: 0, function: { name: 'update_space' } }] },
        finishReason: 'tool_calls',
      },
    ]);
    const caller = new AbortController();
    const completion = modelClient(caller.signal).createNonStream({
      messages: [{ role: 'user', content: 'Update the space.' }],
    });
    await jest.advanceTimersByTimeAsync(600);
    const result = await completion;
    expect(observed.abortReason).toBeUndefined();
    expect(result.finish_reason).toBe('tool_calls');
    expect(result.output.tool_calls).toHaveLength(1);
    expect(result.output.tool_calls?.[0]?.function.name).toBe('update_space');
    expect(result.output.tool_calls?.[0]?.function.arguments).toBe(
      '{"body":"<div> <p>card one</p> <p>card two</p> </div>"}',
    );
  });

  it('records which deadline fired and what the stream last did before it', async () => {
    const { observed } = mockProvider([
      { atMs: 20, delta: { reasoning_content: 'Inspecting the available evidence.' }, finishReason: null },
    ]);
    const caller = new AbortController();
    const completion = modelClient(caller.signal)
      .createNonStream({ messages: [{ role: 'user', content: 'Explain the conflict.' }] })
      .then(
        result => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
    await jest.advanceTimersByTimeAsync(600);
    const settled = await completion;
    expect(observed.abortReason).toMatchObject({ name: 'TimeoutError' });
    // Reasoning arrived (so the first-chunk deadline passed), then nothing: the chunk deadline
    // fired, and the record names the field the last progress arrived under.
    expect(streamDeadlineDetailsOf(settled.error)).toMatchObject({
      deadline: 'chunk',
      timeoutMs: 50,
      lastProgressField: 'reasoning',
    });
  });

  it('preserves explicit caller cancellation instead of replacing it with a later deadline', async () => {
    const { observed } = mockProvider([]);
    const caller = new AbortController();
    const completion = modelClient(caller.signal)
      .createNonStream({ messages: [{ role: 'user', content: 'Hello' }] })
      .then(
        result => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
    await jest.advanceTimersByTimeAsync(20);
    caller.abort(new Error('User cancelled the synthetic turn'));
    await jest.advanceTimersByTimeAsync(600);
    expect((await completion).error).toMatchObject({ message: 'User cancelled the synthetic turn' });
    expect(observed.abortReason).toBe(caller.signal.reason);
    expect(observed.heartbeats).toBeLessThan(4);
  });
});
