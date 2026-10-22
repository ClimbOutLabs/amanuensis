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
import { drainTurnEvents } from '../../../src/apis/turns';
import configuration from '../../../src/config';
import type { IModelProviderStore } from '../../../src/db/modelProviderStore';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { HindsightClient } from '../../../src/runtime/memory/hindsightClient';
import { summarizeTurnContent, type SummarizeTurnResult } from '../../../src/runtime/memory/memorySummarize';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
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
 * One chat, two turns, both drained by the server's drain with memory and turn summaries on.
 * The first turn's summary call is whatever `mockSummarize` does.
 */
async function chatWithTwoTurns() {
  const modelCalls: string[] = [];
  const llm: ILLM = {
    create: jest.fn(() => {
      modelCalls.push(`call-${String(modelCalls.length + 1)}`);
      return answerStream(`Answer ${String(modelCalls.length)}.`);
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
  const sessions = new Sessions({ sessionStore: new InMemorySessionStore() });
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
    const executionDeadline = new TurnExecutionDeadline({
      abortController,
      default_timeout_ms: 60_000,
      finalization_buffer_ms: 1_000,
    });
    executionDeadline.arm();
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
    });
    return { turn, drain, doneSeen: doneSeen.promise };
  }

  return { runTurn, modelCalls, retain, turnDrains, lines };
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
  beforeEach(() => {
    mockSummarize.mockReset();
  });

  it("reaches its first model call while the previous turn's summary model never answers", async () => {
    mockSummarize.mockImplementation(() => new Promise<SummarizeTurnResult>(() => undefined));
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
      mockSummarize.mockImplementation(() => new Promise<SummarizeTurnResult>(() => undefined));
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
});
