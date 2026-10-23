import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import {
  AgentSpecSchema,
  EventType,
  InMemorySessionStore,
  Sessions,
  TurnResourceResolver,
} from '@truefoundry/trueforge-core/agent-session';
import type { ExtendedChatCompletionChunk, ILLM, RawAssistantMessageWithUsage } from '@truefoundry/trueforge-core/core';
import { Writable } from 'stream';
import winston from 'winston';
import { armTurnExecution, drainTurnEvents } from '../../../src/apis/turns';
import configuration from '../../../src/config';
import type { IModelProviderStore } from '../../../src/db/modelProviderStore';
import type { ISandboxProviderStore } from '../../../src/db/sandboxProviderStore';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { HindsightClient } from '../../../src/runtime/memory/hindsightClient';
import { summarizeTurnContent, type SummarizeTurnResult } from '../../../src/runtime/memory/memorySummarize';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { FakeSandboxProvider } from '../../fixtures/fakeSandboxProvider';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

jest.mock('../../../src/runtime/memory/memorySummarize', () => {
  const actual = jest.requireActual<typeof import('../../../src/runtime/memory/memorySummarize')>(
    '../../../src/runtime/memory/memorySummarize',
  );
  return { ...actual, summarizeTurnContent: jest.fn() };
});

const mockSummarize = jest.mocked(summarizeTurnContent);

/** How long the next turn may take to reach its first model call. */
const FIRST_MODEL_CALL_BOUND_MS = 2_000;

const CHART_PATH = '/workspace/chart.png';

/** Each answer declares the chart, as a turn that made or changed it does. */
function answerText(callNumber: number): string {
  return [`Answer ${String(callNumber)}.`, '', '```sandbox_artifacts', `[chart.png](${CHART_PATH})`, '```'].join('\n');
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* answerStream(
  text: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: text },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    finish_reason: 'stop',
  };
}

function summarizeContext() {
  const modelProviderStore: IModelProviderStore = {
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
  };
  return {
    tenantId: 'tenant-1',
    modelProviderStore,
    summarizationModelFqn: 'openai/gpt-4o',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
  };
}

function captureLogger(): { logger: winston.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.json(),
    transports: [new winston.transports.Stream({ stream })],
  });
  return { logger, lines };
}

function withinBound<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} took longer than ${String(FIRST_MODEL_CALL_BOUND_MS)} ms`)),
        FIRST_MODEL_CALL_BOUND_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * One chat, two turns, both drained by the server's drain with memory, turn summaries and
 * artifact saving on. The first turn's summary call is whatever `mockSummarize` does. Each
 * model call stands in for a tool run: it writes its own bytes to the chart in the shared sandbox.
 */
async function chatWithTwoTurns() {
  const modelCalls: string[] = [];
  const sandboxFiles = new Map<string, Buffer | Error>();
  const llm: ILLM = {
    create: jest.fn(() => {
      modelCalls.push(`call-${String(modelCalls.length + 1)}`);
      sandboxFiles.set(CHART_PATH, Buffer.from(`chart from turn ${String(modelCalls.length)}`));
      return answerStream(answerText(modelCalls.length));
    }),
    createNonStream: jest.fn(),
  };
  const silent = winston.createLogger({ silent: true });
  const resolver = () =>
    new TurnResourceResolver({
      llm: () =>
        Promise.resolve({ modelClient: llm, defaultModelParams: {}, modelId: undefined, modelSupportsVision: false }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: silent,
    });
  const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
  const sessions = new Sessions<SessionCustom, TurnCustom>({ sessionStore });
  const turnArtifactStore = new FakeTurnArtifactStore();
  // Unused: the resolver below hands back the fake sandbox directly.
  const sandboxProviderStore: ISandboxProviderStore = {
    getSandboxProvider: jest.fn(),
    getSandboxProviderForUpdate: jest.fn(),
    upsertSandboxProvider: jest.fn(),
    updateSandboxStatus: jest.fn(),
  };
  const session = await sessions.create({
    tenant_id: 'tenant-1',
    session_id: 'session-next-turn',
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({
        model: { name: 'test-provider/test-model' },
        instructions: 'You are a test agent.',
        config: {
          iteration_limit: 5,
          ask_user_questions: { enabled: false },
          dynamic_sub_agents: { enabled: false },
          generative_ui: { enabled: false },
          context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
        },
      }),
    },
    external_id: null,
  });

  const memoryClient = new HindsightClient({
    apiBase: 'https://hindsight.test.example',
    bank: 'aman',
    headers: {},
    fetchImpl: () => Promise.reject(new Error('drain tests must not reach the network')),
  });
  const retain = jest.spyOn(memoryClient, 'retain').mockResolvedValue({ ok: true });
  jest.spyOn(memoryClient, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });

  const registry = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
  const turnDrains = new TurnDrainRegistry();
  const { logger, lines } = captureLogger();

  async function runTurn(input: { turnId: string; previousTurnId: string; text: string }) {
    const abortController = new AbortController();
    const turn = await session.createTurn({
      turn_id: input.turnId,
      input: [{ type: EventType.USER_MESSAGE, content: input.text }],
      previous_turn_id: input.previousTurnId,
      signal: abortController.signal,
      resolver: resolver(),
    });
    // The chat's sandbox, which the next turn inherits from this one.
    await sessionStore.patchSandboxInfo({
      session_id: session.session_id,
      turn_id: turn.id,
      sandbox_info: { sandbox_id: 'sandbox-1' },
    });
    const executionDeadline = new TurnExecutionDeadline({
      abortController,
      default_timeout_ms: 60_000,
      finalization_buffer_ms: 1_000,
    });
    // The step every server path takes after createTurn, before any tool runs.
    await armTurnExecution({ turnDrains, sessionId: session.session_id, executionDeadline, logger });
    const doneSeen = Promise.withResolvers<void>();
    const drain = drainTurnEvents({
      trackedStream: turn.stream(),
      turnEventStream: registry.get(`stream-${input.turnId}`),
      sessionId: session.session_id,
      turnId: turn.id,
      executionDeadline,
      logger,
      turnDrains,
      onEvent: event => {
        if (event.type === EventType.TURN_DONE) {
          doneSeen.resolve();
        }
        return Promise.resolve();
      },
      memory: {
        client: memoryClient,
        userText: input.text,
        attachedFiles: false,
        sessionTitle: undefined,
        summarize: summarizeContext(),
      },
      artifacts: {
        turnArtifactStore,
        sandboxProviderStore,
        sandboxProviderResolver: () => Promise.resolve(new FakeSandboxProvider(sandboxFiles)),
        sessions,
        tenantId: 'tenant-1',
      },
    });
    return { turn, drain, doneSeen: doneSeen.promise };
  }

  async function savedChart(turnId: string): Promise<string | undefined> {
    const record = await turnArtifactStore.getArtifact({
      tenant_id: 'tenant-1',
      session_id: session.session_id,
      turn_id: turnId,
      path: CHART_PATH,
    });
    if (record?.digest === undefined || record.digest === null) {
      return undefined;
    }
    const blob = await turnArtifactStore.getBlob({ tenant_id: 'tenant-1', digest: record.digest });
    return blob?.toString();
  }

  return { runTurn, modelCalls, retain, turnDrains, lines, savedChart };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > FIRST_MODEL_CALL_BOUND_MS) {
      throw new Error('timed out waiting for the expected step');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("the next turn of a chat does not wait on the previous turn's follow-up work", () => {
  // A summary call that stays pending for the rest of its test, then is released so no
  // follow-up work outlives the test.
  let pendingSummary = Promise.withResolvers<void>();
  const summaryPendingUntilTeardown = async (): Promise<SummarizeTurnResult> => {
    await pendingSummary.promise;
    return { status: 'failed', reason: 'released at teardown', fallback: 'model_timeout' };
  };

  beforeEach(() => {
    mockSummarize.mockReset();
    pendingSummary = Promise.withResolvers<void>();
  });

  afterEach(() => {
    pendingSummary.resolve();
  });

  it("reaches its first model call while the previous turn's summary model never answers", async () => {
    mockSummarize.mockImplementation(summaryPendingUntilTeardown);
    const chat = await chatWithTwoTurns();

    const first = await chat.runTurn({ turnId: 'turn-1', previousTurnId: 'none', text: 'Look up a cafe' });
    await first.doneSeen;
    await waitFor(() => mockSummarize.mock.calls.length > 0);

    const second = await withinBound(
      chat.runTurn({ turnId: 'turn-2', previousTurnId: 'turn-1', text: 'Find one' }),
      'Starting the next turn',
    );
    await withinBound(second.doneSeen, 'Answering the next turn');
    expect(chat.modelCalls).toHaveLength(2);
    expect(second.turn.record.state.status).not.toBe('cancelled');
  });

  it('is not delayed by a slow summary, and the first turn is still saved once its summary arrives', async () => {
    const summaryGate = Promise.withResolvers<void>();
    mockSummarize.mockImplementation(async () => {
      await summaryGate.promise;
      return { status: 'summarized', summary: 'The person asked about a cafe.' };
    });
    const chat = await chatWithTwoTurns();
    const firstTurnSummarySaved = expect.objectContaining({
      items: [
        expect.objectContaining({
          document_id: 'aman-session-next-turn-turn-1',
          content: expect.stringContaining('The person asked about a cafe.'),
        }),
      ],
    });

    const first = await chat.runTurn({ turnId: 'turn-1', previousTurnId: 'none', text: 'Look up a cafe' });
    await first.doneSeen;
    await waitFor(() => mockSummarize.mock.calls.length > 0);

    const second = await withinBound(
      chat.runTurn({ turnId: 'turn-2', previousTurnId: 'turn-1', text: 'Find one' }),
      'Starting the next turn',
    );
    await withinBound(second.doneSeen, 'Answering the next turn');
    expect(chat.retain).not.toHaveBeenCalledWith(firstTurnSummarySaved);

    summaryGate.resolve();
    await Promise.all([first.drain, second.drain]);
    expect(chat.retain).toHaveBeenCalledWith(firstTurnSummarySaved);
    expect(chat.turnDrains.size).toBe(0);
  });

  it("saves the first turn's chart as it was, even when the next turn changes it before the first summary is back", async () => {
    const summaryGate = Promise.withResolvers<void>();
    mockSummarize.mockImplementation(async () => {
      await summaryGate.promise;
      return { status: 'summarized', summary: 'The person asked for a chart.' };
    });
    const chat = await chatWithTwoTurns();

    const first = await chat.runTurn({ turnId: 'turn-1', previousTurnId: 'none', text: 'Make a chart' });
    await first.doneSeen;
    await waitFor(() => mockSummarize.mock.calls.length > 0);

    // The next turn's tool rewrites the same file while the first turn's summary is still out.
    const second = await chat.runTurn({ turnId: 'turn-2', previousTurnId: 'turn-1', text: 'Make the title bigger' });
    await withinBound(second.doneSeen, 'Answering the next turn');

    summaryGate.resolve();
    await Promise.all([first.drain, second.drain]);
    expect(await chat.savedChart('turn-1')).toBe('chart from turn 1');
    expect(await chat.savedChart('turn-2')).toBe('chart from turn 2');
  });

  it('keeps the full-text fallback when the summary times out', async () => {
    mockSummarize.mockResolvedValue({ status: 'failed', reason: 'timed out', fallback: 'model_timeout' });
    const chat = await chatWithTwoTurns();

    const first = await chat.runTurn({ turnId: 'turn-1', previousTurnId: 'none', text: 'Look up a cafe' });
    await first.drain;

    expect(chat.retain).toHaveBeenCalledTimes(1);
    const content = chat.retain.mock.calls[0]?.[0].items[0]?.content ?? '';
    expect(content).toContain('Look up a cafe');
    expect(content).toContain('Answer 1.');
  });

  it('stops waiting on follow-up work that outlasts its time limit and logs it', async () => {
    const original = configuration.TURN_FOLLOW_UP_TIMEOUT_MS;
    configuration.TURN_FOLLOW_UP_TIMEOUT_MS = 50;
    try {
      mockSummarize.mockImplementation(summaryPendingUntilTeardown);
      const chat = await chatWithTwoTurns();

      const first = await chat.runTurn({ turnId: 'turn-1', previousTurnId: 'none', text: 'Look up a cafe' });
      await withinBound(first.drain, 'Ending the drain');

      expect(chat.turnDrains.size).toBe(0);
      const entries: Record<string, unknown>[] = chat.lines.map(line => JSON.parse(line));
      const warnings = entries.filter(entry => entry['level'] === 'warn');
      expect(warnings).toEqual([
        expect.objectContaining({
          message: 'Turn follow-up work ran past its time limit; it keeps running in the background',
          sessionId: 'session-next-turn',
          turnId: 'turn-1',
        }),
      ]);
    } finally {
      configuration.TURN_FOLLOW_UP_TIMEOUT_MS = original;
    }
  });

  it('starts after 10 s when the previous turn is still saving its files, and logs it', async () => {
    const turnDrains = new TurnDrainRegistry();
    const { logger, lines } = captureLogger();
    const capture = Promise.withResolvers<void>();
    turnDrains.trackArtifactCapture({ sessionId: 'session-next-turn', turnId: 'turn-1', capture: capture.promise });

    jest.useFakeTimers();
    const executionDeadline = new TurnExecutionDeadline({
      abortController: new AbortController(),
      default_timeout_ms: 60_000,
      finalization_buffer_ms: 1_000,
    });
    try {
      let started = false;
      const waiting = armTurnExecution({
        turnDrains,
        sessionId: 'session-next-turn',
        executionDeadline,
        logger,
      }).then(() => {
        started = true;
      });
      await jest.advanceTimersByTimeAsync(9_999);
      expect(started).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await waiting;
      expect(started).toBe(true);
    } finally {
      executionDeadline.dispose();
      jest.useRealTimers();
      capture.resolve();
    }

    await new Promise(resolve => setImmediate(resolve));
    const entries: Record<string, unknown>[] = lines.map(line => JSON.parse(line));
    expect(entries.filter(entry => entry['level'] === 'warn')).toEqual([
      expect.objectContaining({
        message: 'The previous turn was still saving its files, so this turn started without waiting longer',
        sessionId: 'session-next-turn',
        previousTurnId: 'turn-1',
      }),
    ]);
  });
});
