import { EventType } from '../../src/agent-session/schemas/events';
import { CancellationReason } from '../../src/agent-session/schemas/turn';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import type { AgentCapability } from '../../src/core/capabilities/AgentCapability';
import type {
  AgentContextProcessorAppendContext,
  AgentContextProcessorOutput,
} from '../../src/core/capabilities/AgentContextProcessor';
import { contextCompaction } from '../../src/core/capabilities/builtins/ContextCompaction';
import type { ILLM } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { RemoteMCP } from '../../src/core/mcp/RemoteMCP';
import { InternalEventType } from '../../src/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../src/core/runtime/contextUsage';
import { withTimeout } from '../../src/core/util/promiseUtils';
import { makeMockIMCPServer, makeStubPublicSandbox } from '../core/harnessMocks';
import {
  emptyLlmStream,
  makeAgentSpec,
  makeMockILLM,
  makeSilentLogger,
  makeTestResolver,
  mintTestTurnId,
} from './testHelpers';

function nonCooperatingProcessor<T>(input: { started: () => void; cleanup: () => void }): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T, void, unknown> {
      return {
        next(): Promise<IteratorResult<T, void>> {
          input.started();
          return new Promise<IteratorResult<T, void>>(() => undefined);
        },
        return(): Promise<IteratorResult<T, void>> {
          input.cleanup();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

async function* createSubAgentStream(params: {
  toolName: string;
  workspaceCwd?: string;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const requestInput = {
    name: 'child',
    input: 'Wait until the parent turn is cancelled.',
    ...(params.workspaceCwd === undefined ? {} : { workspace_cwd: params.workspaceCwd }),
  };
  const call = {
    id: 'spawn-child',
    type: 'function',
    function: {
      name: params.toolName,
      arguments: JSON.stringify(requestInput),
    },
  } satisfies NonNullable<RawAssistantMessageWithUsage['output']['tool_calls']>[number];
  yield {
    id: 'spawn-child-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] },
        finish_reason: null,
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

class TrackingAbortSignal implements AbortSignal {
  aborted = false;
  reason: unknown = undefined;
  onabort: AbortSignal['onabort'] = null;
  private readonly abortListeners = new Set<Parameters<AbortSignal['addEventListener']>[1]>();

  readonly addEventListener: AbortSignal['addEventListener'] = (type, callback): void => {
    if (type === 'abort' && callback !== null) {
      this.abortListeners.add(callback);
    }
  };

  readonly removeEventListener: AbortSignal['removeEventListener'] = (type, callback): void => {
    if (type === 'abort' && callback !== null) {
      this.abortListeners.delete(callback);
    }
  };

  readonly dispatchEvent: AbortSignal['dispatchEvent'] = (): boolean => true;

  throwIfAborted(): void {
    if (this.aborted) {
      throw this.reason;
    }
  }

  get abortListenerCount(): number {
    return this.abortListeners.size;
  }
}

async function* waitForCancellationStream(
  signal: AbortSignal,
  started: () => void,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  started();
  if (!signal.aborted) {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  }
  return {
    output: { role: 'assistant', content: null },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

async function* neverSettlingStream(
  started: () => void,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  started();
  await new Promise<void>(() => undefined);
  return {
    output: { role: 'assistant', content: null },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

describe('TurnHandle.stream()', () => {
  const tenant = 'tenant-1';

  async function createSession(options?: {
    dynamicSubAgents?: boolean | undefined;
    delegationModel?: string | undefined;
  }) {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: {
        type: 'inline',
        spec: makeAgentSpec({
          ...(options?.delegationModel === undefined
            ? {}
            : { auxiliary_models: { delegation: { name: options.delegationModel } } }),
          config: {
            sandbox: { enabled: true, file_downloads: true },
            dynamic_sub_agents: { enabled: options?.dynamicSubAgents ?? false },
          },
        }),
      },
      external_id: null,
    });
    return { store, session };
  }

  it('run commits running turn; stream is sole terminal writer → done', async () => {
    const { store, session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    expect(turn.state.status).toBe('running');

    const types: string[] = [];
    for await (const event of turn.stream()) {
      types.push(event.type);
    }
    expect(types[0]).toBe(EventType.TURN_CREATED);
    expect(types[types.length - 1]).toBe(EventType.TURN_DONE);
    expect(turn.state).toMatchObject({
      status: 'done',
      metrics: {},
    });
    if (turn.state.status === 'done') {
      // Token counts are always reported, so an unbilled turn aggregates to 0. Cost and the
      // cache counts stay undefined until a provider actually reports them.
      expect(turn.state.metrics?.total_input_tokens).toBe(0);
      expect(turn.state.metrics?.total_output_tokens).toBe(0);
      expect(turn.state.metrics?.total_tokens).toBe(0);
      expect(turn.state.metrics?.total_cache_read_tokens).toBeUndefined();
      expect(turn.state.metrics?.total_cost_in_usd).toBeUndefined();
    }

    const { data } = await turn.listEvents({ limit: 50 });
    expect(data.some(e => e.type === EventType.TURN_CREATED)).toBe(true);
    expect(data.some(e => e.type === EventType.TURN_DONE)).toBe(true);

    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('done');
    if (stored?.state.status === 'done') {
      expect(stored.state.metrics?.total_cache_read_tokens).toBeUndefined();
    }
  });

  it('persists final turn usage from orchestrator metrics', async () => {
    const { session } = await createSession();
    const turn = await session.createTurn({
      turn_id: 'turn-usage',
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          cache_read_tokens: 4,
          reasoning_tokens: 3,
          cost_in_usd: 0.42,
        },
      }),
    });

    for await (const event of turn.stream()) void event;

    expect(turn.state).toMatchObject({
      status: 'done',
      metrics: {
        total_input_tokens: 12,
        total_output_tokens: 5,
        total_tokens: 17,
        total_cache_read_tokens: 4,
        total_reasoning_tokens: 3,
        total_cost_in_usd: 0.42,
      },
    });
  });

  it('isolates billable usage across turns (Turn 2 does not include Turn 1)', async () => {
    const { session } = await createSession();

    const turn1 = await session.createTurn({
      turn_id: 'turn-isolation-1',
      input: [{ type: EventType.USER_MESSAGE, content: 'turn one' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          cache_read_tokens: 20,
          cost_in_usd: 1.5,
        },
      }),
    });
    for await (const event of turn1.stream()) void event;
    expect(turn1.state).toMatchObject({
      status: 'done',
      metrics: {
        total_input_tokens: 100,
        total_output_tokens: 50,
        total_tokens: 150,
        total_cache_read_tokens: 20,
        total_cost_in_usd: 1.5,
      },
    });

    const turn2 = await session.createTurn({
      turn_id: 'turn-isolation-2',
      input: [{ type: EventType.USER_MESSAGE, content: 'turn two' }],
      previous_turn_id: 'auto',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          total_tokens: 10,
          cache_read_tokens: 1,
          cost_in_usd: 0.05,
        },
      }),
    });
    for await (const event of turn2.stream()) void event;

    expect(turn2.state).toMatchObject({
      status: 'done',
      metrics: {
        total_input_tokens: 7,
        total_output_tokens: 3,
        total_tokens: 10,
        total_cache_read_tokens: 1,
        total_cost_in_usd: 0.05,
      },
    });
    // Explicitly not a sum with turn 1.
    expect(turn2.state.status === 'done' && turn2.state.metrics).not.toMatchObject({
      total_input_tokens: 107,
      total_output_tokens: 53,
      total_tokens: 160,
      total_cost_in_usd: 1.55,
    });
  });

  it('persists cache-read tokens on turn usage', async () => {
    const { session, store } = await createSession();
    const turn = await session.createTurn({
      turn_id: 'turn-cache-read',
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          cache_read_tokens: 4,
          cost_in_usd: 0.42,
        },
      }),
    });

    for await (const event of turn.stream()) void event;

    expect(turn.state).toMatchObject({
      status: 'done',
      metrics: { total_cache_read_tokens: 4 },
    });

    const stored = await store.getTurn({ session_id: 's1', turn_id: turn.id });
    expect(stored?.state).toMatchObject({
      status: 'done',
      metrics: { total_cache_read_tokens: 4 },
    });
  });

  it('background drain reaches terminal done', async () => {
    const { session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    await (async () => {
      for await (const event of turn.stream()) {
        void event;
        // drain
      }
    })();
    expect(turn.state.status).toBe('done');
  });

  it('second stream() call throws', async () => {
    const { session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    await expect(
      (async () => {
        for await (const event of turn.stream()) {
          void event;
          // should throw before yielding
        }
      })(),
    ).rejects.toThrow(/single-use/);
  });

  it('consumer break/abandon without abort writes cancelled ClientCancelled', async () => {
    const { store, session } = await createSession();
    let closeCalls = 0;
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        close: () => {
          closeCalls += 1;
          return Promise.resolve();
        },
      }),
    });
    for await (const event of turn.stream()) {
      expect(event.type).toBe(EventType.TURN_CREATED);
      break;
    }
    expect(turn.state.status).toBe('cancelled');
    if (turn.state.status === 'cancelled') {
      expect(turn.state.reason).toBe(CancellationReason.ClientCancelled);
      expect(turn.state.handoff).toMatchObject({
        cause: 'client_cancelled',
        summary: null,
        evidence: { verification_receipt: { status: 'not_available' } },
      });
    }
    expect(closeCalls).toBe(1);
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('cancelled');
  });

  it('consumer return after abort closes resources without yielding another event', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    let closeCalls = 0;
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({
        close: () => {
          closeCalls += 1;
          return Promise.resolve();
        },
      }),
    });
    const iterator = turn.stream();
    const first = await iterator.next();
    expect(first).toMatchObject({ done: false, value: { type: EventType.TURN_CREATED } });

    controller.abort(CancellationReason.ClientCancelled);
    const returned = await iterator.return(undefined);

    expect(returned.done).toBe(true);
    expect(closeCalls).toBe(1);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
    const stored = await store.getTurn({ session_id: 's1', turn_id: turn.id });
    expect(stored?.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('consumer break after THREAD_CREATED drains synthetic child cleanup without aborting the caller signal', async () => {
    const { store, session } = await createSession({ dynamicSubAgents: true });
    const controller = new AbortController();
    let createCalls = 0;
    const modelClient: ILLM = {
      create: jest.fn(body => {
        createCalls += 1;
        if (createCalls !== 1) {
          throw new Error('consumer-abandonment cleanup must not invoke the model');
        }
        const tool = [...(body.tools ?? [])].find(
          candidate => 'function' in candidate && candidate.function.name.includes('create_sub_agent'),
        );
        if (!tool || !('function' in tool)) {
          throw new Error('dynamic sub-agent tool was not exposed');
        }
        return createSubAgentStream({ toolName: tool.function.name });
      }),
      createNonStream: jest.fn(),
      countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))),
    };
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'delegate then stop streaming' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({ modelClient }),
    });

    for await (const event of turn.stream()) {
      if (event.type === EventType.THREAD_CREATED) {
        break;
      }
    }

    expect(controller.signal.aborted).toBe(false);
    expect(createCalls).toBe(1);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
    const stored = await store.getTurn({ session_id: session.session_id, turn_id: turn.id });
    expect(Object.keys(stored?.snapshot.threads ?? {})).toEqual(['main']);
    const persistedEvents = await turn.listEvents({ limit: 50 });
    expect(persistedEvents.data).toContainEqual(
      expect.objectContaining({
        type: EventType.TOOL_RESPONSE_V2,
        thread_id: 'main',
      }),
    );
    expect(persistedEvents.data).toContainEqual(
      expect.objectContaining({
        type: EventType.THREAD_DONE,
        state: {
          status: 'error',
          error: 'Sub-agent cancelled because the parent turn was cancelled.',
        },
      }),
    );
    expect(persistedEvents.data.filter(event => event.type === EventType.TURN_DONE)).toHaveLength(1);
  });

  it('keeps a child snapshot when THREAD_DONE cannot be appended', async () => {
    const { store, session } = await createSession({ dynamicSubAgents: true });
    const originalAppend = store.appendToEvents.bind(store);
    const removeThreads = jest.spyOn(store, 'removeThreads');
    jest.spyOn(store, 'appendToEvents').mockImplementation(async input => {
      if (input.events.some(event => event.type === EventType.THREAD_DONE)) {
        throw new Error('THREAD_DONE append failed');
      }
      await originalAppend(input);
    });
    const controller = new AbortController();
    let createCalls = 0;
    const modelClient: ILLM = {
      create: jest.fn(body => {
        createCalls += 1;
        if (createCalls !== 1) {
          throw new Error('child cleanup must not invoke a second model call');
        }
        const tool = [...(body.tools ?? [])].find(
          candidate => 'function' in candidate && candidate.function.name.includes('create_sub_agent'),
        );
        if (!tool || !('function' in tool)) {
          throw new Error('dynamic sub-agent tool was not exposed');
        }
        return createSubAgentStream({ toolName: tool.function.name });
      }),
      createNonStream: jest.fn(),
    };
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'delegate then stop streaming' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({ modelClient }),
    });

    await expect(
      (async (): Promise<void> => {
        for await (const event of turn.stream()) {
          if (event.type === EventType.THREAD_CREATED) {
            break;
          }
        }
      })(),
    ).rejects.toThrow('THREAD_DONE append failed');

    const stored = await store.getTurn({ session_id: session.session_id, turn_id: turn.id });
    expect(Object.keys(stored?.snapshot.threads ?? {})).toHaveLength(2);
    expect(removeThreads).not.toHaveBeenCalled();
    expect(createCalls).toBe(1);
  });

  it('does not revive a child snapshot from a terminal turn after process reconstruction', async () => {
    const { store, session } = await createSession({ dynamicSubAgents: true });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'start a delegated task' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    await store.addThreads({
      session_id: session.session_id,
      turn_id: turn.id,
      threads: [
        {
          thread_id: 'orphaned-child',
          parent: { thread_id: 'main', tool_call_id: 'spawn-child' },
          agent_info: { type: 'dynamic', name: 'child', input: 'do work' },
          context: [],
          current_context_usage: getEmptyCurrentContextUsage(),
          completion: null,
          capability_state: null,
          tool_call_memo: undefined,
          task_state: undefined,
        },
      ],
    });
    await session.freezeTurn({ turn_id: turn.id, reason: CancellationReason.ClientCancelled });

    // A fresh SessionHandle models a process restart: its only knowledge is
    // the terminal record, whose stale child snapshot must never be resumed.
    const sessions = new Sessions({ sessionStore: store });
    const reconstructed = await sessions.get({ tenant_id: tenant, session_id: session.session_id });
    if (!reconstructed) throw new Error('Expected reconstructed session');
    const next = await reconstructed.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'continue' }],
      previous_turn_id: turn.id,
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });

    expect(Object.keys(next.record.snapshot.threads)).toEqual(['main']);
    const persistedNext = await store.getTurn({ session_id: session.session_id, turn_id: next.id });
    expect(Object.keys(persistedNext?.snapshot.threads ?? {})).toEqual(['main']);
    const terminalPredecessor = await store.getTurn({ session_id: session.session_id, turn_id: turn.id });
    expect(terminalPredecessor?.snapshot.threads['orphaned-child']).toBeDefined();
  });

  it('detaches caller abort listeners after normal and failed terminal paths', async () => {
    const normal = await createSession();
    const normalSignal = new TrackingAbortSignal();
    const normalTurn = await normal.session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'complete normally' }],
      previous_turn_id: 'none',
      signal: normalSignal,
      resolver: makeTestResolver(),
    });
    for await (const event of normalTurn.stream()) void event;
    expect(normalSignal.abortListenerCount).toBe(0);

    const failed = await createSession();
    const failedSignal = new TrackingAbortSignal();
    const failedTurn = await failed.session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'fail once' }],
      previous_turn_id: 'none',
      signal: failedSignal,
      resolver: makeTestResolver({
        modelClient: {
          create: jest.fn(() => {
            throw new Error('model failed');
          }),
          createNonStream: jest.fn(),
        },
      }),
    });
    for await (const event of failedTurn.stream()) void event;
    expect(failedSignal.abortListenerCount).toBe(0);
  });

  it('abort mid-drain writes terminal cancelled', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver(),
    });
    controller.abort(CancellationReason.ClientCancelled);
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    expect(turn.state.status).toBe('cancelled');
    if (turn.state.status === 'cancelled') {
      expect(turn.state.reason).toBe(CancellationReason.ClientCancelled);
    }
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('cancelled');
  });

  it('abort terminalizes a turn when the provider stream never settles', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const modelStarted = Promise.withResolvers<void>();
    const modelClient: ILLM = {
      create: jest.fn(() => neverSettlingStream(modelStarted.resolve)),
      createNonStream: jest.fn(),
    };
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({ modelClient, defaultModelParams: {}, modelId: undefined, modelSupportsVision: false }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver,
    });

    const eventTypes: string[] = [];
    const drain = (async () => {
      for await (const event of turn.stream()) {
        eventTypes.push(event.type);
      }
    })();
    await modelStarted.promise;
    controller.abort(CancellationReason.ClientCancelled);
    await withTimeout(drain, 1_000, 'provider stream abort');

    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
      handoff: { cause: 'client_cancelled', summary: null },
    });
    expect(eventTypes).toContain(EventType.TURN_DONE);
    const stored = await store.getTurn({ session_id: 's1', turn_id: turn.id });
    expect(stored?.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('cancellation during a blocking preLLM processor prevents compaction and ordinary model dispatch', async () => {
    const { session } = await createSession();
    const controller = new AbortController();
    const processorStarted = Promise.withResolvers<void>();
    const releaseProcessor = Promise.withResolvers<void>();
    const ordinaryModel = makeMockILLM({
      create: jest.fn().mockImplementation(() => emptyLlmStream()),
    });
    const compactionModel = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: 'must not run' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const blockingCapability: AgentCapability = {
      preLLMProcessors: [
        {
          async *processPreLLM(): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
            processorStarted.resolve();
            await releaseProcessor.promise;
            yield* [];
          },
        },
      ],
    };
    const compactionCapability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: ordinaryModel },
      compactionModel: { modelClient: compactionModel, modelParams: {} },
      compactionThresholdTokens: 1,
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'cancel during preprocessing' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({
        modelClient: ordinaryModel,
        extraCapabilities: [blockingCapability, compactionCapability],
      }),
    });

    const streamedTerminalEvents: string[] = [];
    const drain = (async () => {
      for await (const event of turn.stream()) {
        if (event.type === EventType.TURN_DONE) {
          streamedTerminalEvents.push(event.id);
        }
      }
    })();
    await processorStarted.promise;
    controller.abort(CancellationReason.ClientCancelled);
    releaseProcessor.resolve();
    await withTimeout(drain, 1_000, 'preLLM processor cancellation');

    expect(ordinaryModel.create).not.toHaveBeenCalled();
    expect(compactionModel.createNonStream).not.toHaveBeenCalled();
    expect(streamedTerminalEvents).toHaveLength(1);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
      handoff: { cause: 'client_cancelled', summary: null },
    });
    const { data } = await turn.listEvents({ limit: 50 });
    expect(data.filter(event => event.type === EventType.TURN_DONE)).toHaveLength(1);
  });

  it('cancellation during a non-cooperating preSend processor terminalizes turn creation once', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const processorStarted = Promise.withResolvers<void>();
    const processorCleanup = jest.fn();
    const modelClient = makeMockILLM({ create: jest.fn(() => emptyLlmStream()) });
    const capability: AgentCapability = {
      preSendProcessors: [
        {
          processPreSend: () =>
            nonCooperatingProcessor<AgentContextProcessorAppendContext>({
              started: processorStarted.resolve,
              cleanup: processorCleanup,
            }),
        },
      ],
    };

    const turnPromise = session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'cancel during send preprocessing' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({ modelClient, extraCapabilities: [capability] }),
    });
    await processorStarted.promise;
    controller.abort(CancellationReason.ClientCancelled);
    const turn = await turnPromise;

    const terminalEvents: string[] = [];
    for await (const event of turn.stream()) {
      if (event.type === EventType.TURN_DONE) {
        terminalEvents.push(event.id);
      }
    }

    expect(modelClient.create).not.toHaveBeenCalled();
    expect(processorCleanup).toHaveBeenCalledTimes(1);
    expect(terminalEvents).toHaveLength(1);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
    const stored = await store.getTurn({ session_id: 's1', turn_id: turn.id });
    expect(stored?.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('cancellation during a non-cooperating postToolCall processor prevents the next model call', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const processorStarted = Promise.withResolvers<void>();
    const processorCleanup = jest.fn();
    const toolSet = makeMockIMCPServer({ name: 'post-tool-test', preload: true });
    jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: 'tool_a',
      is_approval_required: false,
      // The turn classifies unstamped tool calls through Sentinel, which fails
      // closed to Tier 3: without this stamp the tool parks behind an approval
      // card and the postToolCall processor never starts. Stamp the fixture as
      // already classified so the test exercises cancellation, not admission.
      tier: 1,
    });
    jest.mocked(toolSet.callTool).mockResolvedValue(toolResultResponse({ text: 'tool complete' }));
    const toolCall = {
      id: 'post-tool-call',
      type: 'function' as const,
      function: { name: 'tool_a', arguments: '{}' },
    };
    const modelClient: ILLM = {
      create: jest.fn().mockImplementationOnce(() =>
        (async function* (): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
          return {
            output: { role: 'assistant', content: null, tool_calls: [toolCall] },
            usage: getEmptyUsage(),
            finish_reason: 'tool_calls',
          };
        })(),
      ),
      createNonStream: jest.fn(),
    };
    const capability: AgentCapability = {
      systemToolSets: [toolSet],
      postToolCallProcessors: [
        {
          processPostToolCall: () =>
            nonCooperatingProcessor<AgentContextProcessorOutput>({
              started: processorStarted.resolve,
              cleanup: processorCleanup,
            }),
        },
      ],
    };
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'cancel after the tool call' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({ modelClient, extraCapabilities: [capability] }),
    });

    const drain = (async () => {
      for await (const _event of turn.stream()) {
        // Drain until the turn's durable terminal event.
      }
    })();
    await processorStarted.promise;
    controller.abort(CancellationReason.ClientCancelled);
    await drain;

    expect(modelClient.create).toHaveBeenCalledTimes(1);
    expect(processorCleanup).toHaveBeenCalledTimes(1);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
    const stored = await store.getTurn({ session_id: 's1', turn_id: turn.id });
    expect(stored?.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('cancellation does not wait for a non-cooperating preLLM processor', async () => {
    const { session } = await createSession();
    const controller = new AbortController();
    const processorStarted = Promise.withResolvers<void>();
    const processorCleanup = jest.fn();
    const ordinaryModel = makeMockILLM({
      create: jest.fn().mockImplementation(() => emptyLlmStream()),
    });
    const compactionModel = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: 'must not run' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const nonCooperatingCapability: AgentCapability = {
      preLLMProcessors: [
        {
          processPreLLM(): AsyncIterable<AgentContextProcessorOutput> {
            return {
              [Symbol.asyncIterator]() {
                return {
                  next() {
                    processorStarted.resolve();
                    return new Promise<IteratorResult<AgentContextProcessorOutput, void>>(() => undefined);
                  },
                  return() {
                    processorCleanup();
                    return Promise.resolve({ done: true, value: undefined });
                  },
                };
              },
            };
          },
        },
      ],
    };
    const compactionCapability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: ordinaryModel },
      compactionModel: { modelClient: compactionModel, modelParams: {} },
      compactionThresholdTokens: 1,
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'cancel a stuck preLLM processor' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({
        modelClient: ordinaryModel,
        extraCapabilities: [nonCooperatingCapability, compactionCapability],
      }),
    });

    const streamedTerminalEvents: string[] = [];
    const drain = (async () => {
      for await (const event of turn.stream()) {
        if (event.type === EventType.TURN_DONE) {
          streamedTerminalEvents.push(event.id);
        }
      }
    })();
    await processorStarted.promise;
    controller.abort(CancellationReason.ClientCancelled);
    await withTimeout(drain, 1_000, 'non-cooperating preLLM processor cancellation');

    expect(ordinaryModel.create).not.toHaveBeenCalled();
    expect(compactionModel.createNonStream).not.toHaveBeenCalled();
    expect(processorCleanup).toHaveBeenCalledTimes(1);
    expect(streamedTerminalEvents).toHaveLength(1);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
      handoff: { cause: 'client_cancelled', summary: null },
    });
    const { data } = await turn.listEvents({ limit: 50 });
    expect(data.filter(event => event.type === EventType.TURN_DONE)).toHaveLength(1);
  });

  it('discards preLLM output that settles after cancellation', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const processorStarted = Promise.withResolvers<void>();
    const lateResult = Promise.withResolvers<IteratorResult<AgentContextProcessorOutput, void>>();
    const processorCleanup = jest.fn();
    const ordinaryModel = makeMockILLM({
      create: jest.fn().mockImplementation(() => emptyLlmStream()),
    });
    const compactionModel = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: 'must not run' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const lateCapability: AgentCapability = {
      preLLMProcessors: [
        {
          processPreLLM(): AsyncIterable<AgentContextProcessorOutput> {
            return {
              [Symbol.asyncIterator]() {
                return {
                  next() {
                    processorStarted.resolve();
                    return lateResult.promise;
                  },
                  return() {
                    processorCleanup();
                    return Promise.resolve({ done: true, value: undefined });
                  },
                };
              },
            };
          },
        },
      ],
    };
    const compactionCapability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: ordinaryModel },
      compactionModel: { modelClient: compactionModel, modelParams: {} },
      compactionThresholdTokens: 1,
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'ignore late processor output' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({
        modelClient: ordinaryModel,
        extraCapabilities: [lateCapability, compactionCapability],
      }),
    });

    const drain = (async () => {
      for await (const _event of turn.stream()) {
        // Drain through the durable terminal event.
      }
    })();
    await processorStarted.promise;
    controller.abort(CancellationReason.ClientCancelled);
    await withTimeout(drain, 1_000, 'late preLLM processor output cancellation');

    lateResult.resolve({
      done: false,
      value: {
        type: InternalEventType.AGENT_CONTEXT_APPEND,
        context: [{ role: 'user', content: 'late processor context' }],
        output: [],
        tool_call_memo: undefined,
        task_state: undefined,
      },
    });
    await lateResult.promise;

    const stored = await store.getTurn({ session_id: 's1', turn_id: turn.id });
    expect(stored?.snapshot.threads['main']?.context).not.toContainEqual({
      role: 'user',
      content: 'late processor context',
    });
    expect(ordinaryModel.create).not.toHaveBeenCalled();
    expect(compactionModel.createNonStream).not.toHaveBeenCalled();
    expect(processorCleanup).toHaveBeenCalledTimes(1);
    const { data } = await turn.listEvents({ limit: 50 });
    expect(data.filter(event => event.type === EventType.TURN_DONE)).toHaveLength(1);
  });

  it('abort between provider reads requests cleanup without stranding the turn', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const providerStream = neverSettlingStream(() => undefined);
    const close = jest.spyOn(providerStream, 'return').mockRejectedValue(new Error('provider cleanup failed'));
    const modelClient: ILLM = {
      create: jest.fn(() => providerStream),
      createNonStream: jest.fn(),
    };
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({ modelClient, defaultModelParams: {}, modelId: undefined, modelSupportsVision: false }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver,
    });

    for await (const event of turn.stream()) {
      if (event.type === EventType.MODEL_MESSAGE) {
        controller.abort(CancellationReason.ClientCancelled);
      }
    }

    expect(close).toHaveBeenCalledTimes(1);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
    const stored = await store.getTurn({ session_id: 's1', turn_id: turn.id });
    expect(stored?.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('explicit cancel finishes an active child and accepts the next user message', async () => {
    const { store, session } = await createSession({ dynamicSubAgents: true });
    const controller = new AbortController();
    const childStarted = Promise.withResolvers<void>();
    let createCalls = 0;
    const modelClient: ILLM = {
      create: jest.fn(body => {
        createCalls += 1;
        if (createCalls === 1) {
          let toolName: string | undefined;
          for (const candidate of body.tools ?? []) {
            if ('function' in candidate && candidate.function.name.includes('create_sub_agent')) {
              toolName = candidate.function.name;
              break;
            }
          }
          if (!toolName) {
            throw new Error('dynamic sub-agent tool was not exposed');
          }
          return createSubAgentStream({ toolName, workspaceCwd: 'C:/work/amanuensis' });
        }
        if (createCalls === 2) {
          return waitForCancellationStream(controller.signal, childStarted.resolve);
        }
        return emptyLlmStream();
      }),
      createNonStream: jest.fn(),
    };
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({ modelClient, defaultModelParams: {}, modelId: undefined, modelSupportsVision: false }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'delegate a task' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver,
    });

    const streamedEvents: string[] = [];
    const drain = (async () => {
      for await (const event of turn.stream()) {
        streamedEvents.push(event.type);
      }
    })();
    await childStarted.promise;
    controller.abort(CancellationReason.ClientCancelled);
    await drain;

    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
    expect(streamedEvents).toContain(EventType.THREAD_DONE);
    expect(createCalls).toBe(2);
    expect(streamedEvents.filter(type => type === EventType.TURN_DONE)).toHaveLength(1);
    const persistedEvents = await turn.listEvents({ limit: 50 });
    expect(persistedEvents.data).toContainEqual(
      expect.objectContaining({
        type: EventType.THREAD_CREATED,
        agent_info: expect.objectContaining({ workspace_cwd: 'C:/work/amanuensis' }),
      }),
    );
    expect(persistedEvents.data).toContainEqual(
      expect.objectContaining({
        type: EventType.THREAD_DONE,
        state: {
          status: 'error',
          error: 'Sub-agent cancelled because the parent turn was cancelled.',
        },
      }),
    );
    const cancelled = await store.getTurn({ session_id: session.session_id, turn_id: turn.id });
    expect(Object.keys(cancelled?.snapshot.threads ?? {})).toEqual(['main']);

    const nextTurn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'continue with a different request' }],
      previous_turn_id: turn.id,
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    for await (const event of nextTurn.stream()) void event;
    expect(nextTurn.state.status).toBe('done');
  });

  it('explicit cancel cannot strand child cleanup behind a non-cooperating parent preSend processor', async () => {
    const { session } = await createSession({ dynamicSubAgents: true });
    const controller = new AbortController();
    const childStarted = Promise.withResolvers<void>();
    const cleanupProcessorStarted = jest.fn();
    const cleanupProcessorClosed = jest.fn();
    let parentPreSendCalls = 0;
    const cleanupCapability: AgentCapability = {
      preSendProcessors: [
        {
          processPreSend(execution): AsyncIterable<AgentContextProcessorAppendContext> {
            if (execution.threadId !== 'main') {
              return (async function* (): AsyncGenerator<AgentContextProcessorAppendContext, void, unknown> {
                return;
              })();
            }
            parentPreSendCalls += 1;
            if (parentPreSendCalls === 1) {
              return (async function* (): AsyncGenerator<AgentContextProcessorAppendContext, void, unknown> {
                return;
              })();
            }
            return nonCooperatingProcessor<AgentContextProcessorAppendContext>({
              started: cleanupProcessorStarted,
              cleanup: cleanupProcessorClosed,
            });
          },
        },
      ],
    };
    let createCalls = 0;
    const modelClient: ILLM = {
      create: jest.fn(body => {
        createCalls += 1;
        if (createCalls === 1) {
          let toolName: string | undefined;
          for (const candidate of body.tools ?? []) {
            if ('function' in candidate && candidate.function.name.includes('create_sub_agent')) {
              toolName = candidate.function.name;
              break;
            }
          }
          if (!toolName) {
            throw new Error('dynamic sub-agent tool was not exposed');
          }
          return createSubAgentStream({ toolName });
        }
        if (createCalls === 2) {
          return waitForCancellationStream(controller.signal, childStarted.resolve);
        }
        throw new Error('cancellation cleanup must not invoke the model');
      }),
      createNonStream: jest.fn(),
    };
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'delegate then cancel' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({ modelClient, extraCapabilities: [cleanupCapability] }),
    });

    const terminalEvents: string[] = [];
    const drain = (async () => {
      for await (const event of turn.stream()) {
        if (event.type === EventType.TURN_DONE) {
          terminalEvents.push(event.id);
        }
      }
    })();
    await childStarted.promise;
    controller.abort(CancellationReason.ClientCancelled);
    await withTimeout(drain, 1_000, 'sub-agent cancellation cleanup preSend');

    expect(cleanupProcessorStarted).not.toHaveBeenCalled();
    expect(cleanupProcessorClosed).not.toHaveBeenCalled();
    expect(parentPreSendCalls).toBe(1);
    expect(createCalls).toBe(2);
    expect(terminalEvents).toHaveLength(1);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('cancellation during dynamic-child repository refresh does not create or run the child', async () => {
    const { session } = await createSession({ dynamicSubAgents: true });
    const sandbox = makeStubPublicSandbox();
    const refreshStarted = Promise.withResolvers<void>();
    const refreshPending = new Promise<void>(() => undefined);
    let refreshCalls = 0;
    jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockImplementation(() => {
      refreshCalls += 1;
      if (refreshCalls < 3) {
        return Promise.resolve();
      }
      refreshStarted.resolve();
      return refreshPending;
    });

    const controller = new AbortController();
    let modelCalls = 0;
    const modelClient: ILLM = {
      create: jest.fn(body => {
        modelCalls += 1;
        if (modelCalls !== 1) {
          throw new Error('child model must not run after cancellation');
        }
        const toolName = [...(body.tools ?? [])].find(
          candidate => 'function' in candidate && candidate.function.name.includes('create_sub_agent'),
        );
        if (!toolName || !('function' in toolName)) {
          throw new Error('dynamic sub-agent tool was not exposed');
        }
        return createSubAgentStream({ toolName: toolName.function.name });
      }),
      createNonStream: jest.fn(),
    };
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'create a child while refresh is unavailable' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver({ modelClient, sandbox }),
    });

    const streamedTypes: string[] = [];
    const drain = (async () => {
      for await (const event of turn.stream()) {
        streamedTypes.push(event.type);
      }
    })();
    await refreshStarted.promise;
    controller.abort(CancellationReason.ClientCancelled);
    await drain;

    expect(modelCalls).toBe(1);
    expect(streamedTypes).not.toContain(EventType.THREAD_CREATED);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('propagates cancellation through dynamic subagent repository refresh', async () => {
    const { session } = await createSession({ dynamicSubAgents: true });
    const controller = new AbortController();
    const dynamicRefreshStarted = Promise.withResolvers<AbortSignal>();
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'close').mockResolvedValue(undefined);
    let refreshCount = 0;
    const refresh = jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockImplementation(options => {
      refreshCount += 1;
      if (refreshCount < 3) {
        return Promise.resolve();
      }
      const signal = options?.signal;
      if (signal === undefined) {
        return Promise.reject(new Error('dynamic refresh did not receive the turn signal'));
      }
      dynamicRefreshStarted.resolve(signal);
      if (signal.aborted) {
        return Promise.reject(new Error('dynamic refresh cancelled'));
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('dynamic refresh cancelled')), { once: true });
      });
    });
    const modelClient: ILLM = {
      create: jest.fn(body => {
        let toolName: string | undefined;
        for (const candidate of body.tools ?? []) {
          if ('function' in candidate && candidate.function.name.includes('create_sub_agent')) {
            toolName = candidate.function.name;
            break;
          }
        }
        if (toolName === undefined) {
          throw new Error('dynamic sub-agent tool was not exposed');
        }
        return createSubAgentStream({ toolName });
      }),
      createNonStream: jest.fn(),
    };
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({ modelClient, defaultModelParams: {}, modelId: undefined, modelSupportsVision: false }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      sandboxProvider: () => Promise.resolve(sandbox),
      logger: makeSilentLogger(),
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'delegate and then cancel' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver,
    });

    const drain = (async () => {
      for await (const _event of turn.stream()) {
        // Drain until cancellation reaches the blocked dynamic refresh.
      }
    })();
    const propagatedSignal = await withTimeout(dynamicRefreshStarted.promise, 500, 'dynamic repository refresh');
    expect(propagatedSignal.aborted).toBe(false);
    controller.abort(CancellationReason.ClientCancelled);
    await withTimeout(drain, 500, 'dynamic repository refresh cancellation');

    expect(refresh).toHaveBeenCalledTimes(3);
    expect(propagatedSignal.aborted).toBe(true);
    expect(refresh.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
    expect(refresh.mock.calls.slice(1).every(call => call[0]?.signal === propagatedSignal)).toBe(true);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('does not continue child construction when cancellation wins after repository refresh', async () => {
    const { session } = await createSession({ dynamicSubAgents: true });
    const controller = new AbortController();
    const dynamicRefreshStarted = Promise.withResolvers<void>();
    const releaseDynamicRefresh = Promise.withResolvers<void>();
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'close').mockResolvedValue(undefined);
    let refreshCount = 0;
    jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockImplementation(() => {
      refreshCount += 1;
      if (refreshCount < 3) {
        return Promise.resolve();
      }
      dynamicRefreshStarted.resolve();
      return releaseDynamicRefresh.promise;
    });
    const modelClient: ILLM = {
      create: jest.fn(body => {
        let toolName: string | undefined;
        for (const candidate of body.tools ?? []) {
          if ('function' in candidate && candidate.function.name.includes('create_sub_agent')) {
            toolName = candidate.function.name;
            break;
          }
        }
        if (toolName === undefined) {
          throw new Error('dynamic sub-agent tool was not exposed');
        }
        return createSubAgentStream({ toolName });
      }),
      createNonStream: jest.fn(),
    };
    const resolveModel = jest.fn(() =>
      Promise.resolve({ modelClient, defaultModelParams: {}, modelId: undefined, modelSupportsVision: false }),
    );
    const resolver = new TurnResourceResolver({
      llm: resolveModel,
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      sandboxProvider: () => Promise.resolve(sandbox),
      logger: makeSilentLogger(),
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'delegate and cancel after refresh' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver,
    });
    const streamedEvents: string[] = [];

    const drain = (async (): Promise<void> => {
      for await (const event of turn.stream()) {
        streamedEvents.push(event.type);
      }
    })();
    await withTimeout(dynamicRefreshStarted.promise, 500, 'late dynamic repository refresh');
    controller.abort(CancellationReason.ClientCancelled);
    releaseDynamicRefresh.resolve();
    await withTimeout(drain, 500, 'post-refresh cancellation fence');

    expect(resolveModel).toHaveBeenCalledTimes(1);
    expect(streamedEvents).not.toContain(EventType.THREAD_CREATED);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('does not emit a child when cancellation wins during dynamic definition resolution', async () => {
    // A distinct delegation model keeps the child's model resolution from sharing the root's
    // already-settled promise: TurnResourceResolver.getModel single-flights by model name, so a
    // same-named child would resolve instantly from cache and never expose a pending window here.
    const { session } = await createSession({
      dynamicSubAgents: true,
      delegationModel: 'test-provider/delegation-model',
    });
    const controller = new AbortController();
    const childDefinitionStarted = Promise.withResolvers<void>();
    const releaseChildDefinition = Promise.withResolvers<void>();
    const modelClient: ILLM = {
      create: jest.fn(body => {
        let toolName: string | undefined;
        for (const candidate of body.tools ?? []) {
          if ('function' in candidate && candidate.function.name.includes('create_sub_agent')) {
            toolName = candidate.function.name;
            break;
          }
        }
        if (toolName === undefined) {
          throw new Error('dynamic sub-agent tool was not exposed');
        }
        return createSubAgentStream({ toolName });
      }),
      createNonStream: jest.fn(),
    };
    let resolveCount = 0;
    const resolver = new TurnResourceResolver({
      llm: async () => {
        resolveCount += 1;
        if (resolveCount === 2) {
          childDefinitionStarted.resolve();
          await releaseChildDefinition.promise;
        }
        return { modelClient, defaultModelParams: {}, modelId: undefined, modelSupportsVision: false };
      },
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'delegate and cancel during child resolution' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver,
    });
    const streamedEvents: string[] = [];

    const drain = (async (): Promise<void> => {
      for await (const event of turn.stream()) {
        streamedEvents.push(event.type);
      }
    })();
    await withTimeout(childDefinitionStarted.promise, 500, 'dynamic child definition');
    controller.abort(CancellationReason.ClientCancelled);
    releaseChildDefinition.resolve();
    await withTimeout(drain, 500, 'post-definition cancellation fence');

    expect(resolveCount).toBe(2);
    expect(streamedEvents).not.toContain(EventType.THREAD_CREATED);
    expect(turn.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('abort with Abandoned persists reason abandoned', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver(),
    });
    controller.abort(CancellationReason.Abandoned);
    for await (const event of turn.stream()) {
      void event;
    }
    expect(turn.state.status).toBe('cancelled');
    if (turn.state.status === 'cancelled') {
      expect(turn.state.reason).toBe(CancellationReason.Abandoned);
    }
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('cancelled');
    if (stored?.state.status === 'cancelled') {
      expect(stored.state.reason).toBe(CancellationReason.Abandoned);
    }
  });

  it('abort with ServerExecutionTimeout persists reason server-execution-timeout', async () => {
    const { store, session } = await createSession();
    const controller = new AbortController();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver: makeTestResolver(),
    });
    controller.abort(CancellationReason.ServerExecutionTimeout);
    for await (const event of turn.stream()) {
      void event;
    }
    expect(turn.state.status).toBe('cancelled');
    if (turn.state.status === 'cancelled') {
      expect(turn.state.reason).toBe(CancellationReason.ServerExecutionTimeout);
    }
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('cancelled');
    if (stored?.state.status === 'cancelled') {
      expect(stored.state.reason).toBe(CancellationReason.ServerExecutionTimeout);
    }
  });

  it('resolver.close() called once in finally; throwing close does not flip terminal state', async () => {
    const { store, session } = await createSession();
    let closeCalls = 0;
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        close: () => {
          closeCalls += 1;
          return Promise.reject(new Error('close boom'));
        },
      }),
    });
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    expect(closeCalls).toBe(1);
    expect(turn.state.status).toBe('done');
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('done');
  });

  it('publishes the durable terminal event before resource cleanup can delay live delivery', async () => {
    const { store, session } = await createSession();
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    let closeCalls = 0;
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({
        close: async () => {
          closeCalls += 1;
          cleanupStarted.resolve();
          await releaseCleanup.promise;
        },
      }),
    });
    const iterator = turn.stream();
    const terminalSeen = (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error('turn stream ended without a terminal event');
        }
        if (next.value.type === EventType.TURN_DONE) {
          return next.value;
        }
      }
    })();

    const first: 'terminal' | 'cleanup' = await Promise.race([
      terminalSeen.then((): 'terminal' => 'terminal'),
      cleanupStarted.promise.then((): 'cleanup' => 'cleanup'),
    ]);

    if (first === 'terminal') {
      await terminalSeen;
      const storedBeforeCleanup = await store.getTurn({
        session_id: 's1',
        turn_id: turn.id,
      });
      expect(storedBeforeCleanup?.state.status).toBe('done');
      const completion = iterator.next();
      await cleanupStarted.promise;
      releaseCleanup.resolve();
      await completion;
    } else {
      releaseCleanup.resolve();
      await terminalSeen;
      await iterator.next();
    }

    expect(first).toBe('terminal');
    expect(closeCalls).toBe(1);
    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('done');
  });

  it('TurnResourceResolver.close() closes sandbox handle once and is idempotent', async () => {
    const sandbox = makeStubPublicSandbox();
    const closeSpy = jest.spyOn(sandbox, 'close').mockResolvedValue(undefined);
    const logger = makeSilentLogger();
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: makeMockILLM({ create: jest.fn().mockImplementation(() => emptyLlmStream()) }),
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: () => Promise.resolve({ url: 'http://localhost' }),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      sandboxProvider: () => Promise.resolve(sandbox),
      logger,
    });
    const { session } = await createSession();
    // Spec already has sandbox.enabled from createSession helper.
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver,
    });
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await resolver.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TurnResourceResolver caches', () => {
  it('getOrCreateToolSource single-flights by id', async () => {
    const logger = makeSilentLogger();
    let creates = 0;
    const resolver = new (class extends TurnResourceResolver {
      async resolveTwice() {
        const create = async () => {
          creates += 1;
          await new Promise(r => setTimeout(r, 10));
          return new RemoteMCP({
            id: 'svc',
            name: 'svc',
            url: 'http://example.invalid',
            headers: {},
            logger,
            tracing: this.createTracing(),
            requestTimeoutMs: 60_000,
            connectTimeoutMs: 5_000,
            signal: new AbortController().signal,
          });
        };
        const [a, b] = await Promise.all([
          this.getOrCreateToolSource({ id: 'svc', create }),
          this.getOrCreateToolSource({ id: 'svc', create }),
        ]);
        expect(a).toBe(b);
      }
    })({
      llm: () =>
        Promise.resolve({
          modelClient: makeMockILLM(),
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: () => Promise.resolve({ url: 'http://example.invalid' }),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger,
    });
    await resolver.resolveTwice();
    expect(creates).toBe(1);
  });

  it('getModel single-flights by model name', async () => {
    const logger = makeSilentLogger();
    let llmCalls = 0;
    const modelClient = makeMockILLM();
    const resolver = new (class extends TurnResourceResolver {
      async resolveTwice() {
        const [a, b] = await Promise.all([this.getModel('acct/model-a'), this.getModel('acct/model-a')]);
        expect(a).toBe(b);
      }
    })({
      llm: async () => {
        llmCalls += 1;
        await new Promise(r => setTimeout(r, 10));
        return { modelClient, defaultModelParams: {}, modelId: undefined, modelSupportsVision: false };
      },
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger,
    });
    await resolver.resolveTwice();
    expect(llmCalls).toBe(1);
  });

  it('resolveSandbox called once per run via SessionHandle.createTurn', async () => {
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'close').mockResolvedValue(undefined);
    const configureCodeMode = jest.spyOn(sandbox, 'configureCodeMode');
    const refreshRepositoryState = jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockResolvedValue(undefined);
    jest.spyOn(sandbox, 'getCurrentSandboxInfo').mockReturnValue({ sandbox_id: 'v1:test:bound-sandbox' });
    let sandboxCreates = 0;
    const logger = makeSilentLogger();
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: makeMockILLM({ create: jest.fn().mockImplementation(() => emptyLlmStream()) }),
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: () => Promise.resolve({ url: 'http://localhost' }),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      sandboxProvider: () => {
        sandboxCreates += 1;
        return Promise.resolve(sandbox);
      },
      logger,
    });
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 't',
      session_id: 's',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: {
        type: 'inline',
        spec: makeAgentSpec({
          config: {
            sandbox: { enabled: true, file_downloads: true },
          },
        }),
      },
      external_id: null,
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hi' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver,
    });
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    expect(sandboxCreates).toBe(1);
    expect(refreshRepositoryState).toHaveBeenCalledTimes(2);
    const constructionRefresh = refreshRepositoryState.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const requestRefresh = refreshRepositoryState.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY;
    expect(configureCodeMode.mock.invocationCallOrder[0]).toBeLessThan(constructionRefresh);
    expect(constructionRefresh).toBeLessThan(requestRefresh);
    const stored = await store.getTurn({ session_id: 's', turn_id: turn.id });
    expect(stored?.snapshot.sandbox_info).toEqual({ sandbox_id: 'v1:test:bound-sandbox' });
  });
});
