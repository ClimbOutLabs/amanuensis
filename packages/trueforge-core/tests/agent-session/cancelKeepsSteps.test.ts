import { Sessions } from '../../src/agent-session/Sessions';
import { EventType as TurnEventType } from '../../src/agent-session/schemas/events';
import { CancellationReason } from '../../src/agent-session/schemas/turn';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { EventType } from '../../src/core/events/schema';
import type { ILLM } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { makeAgentSpec, makeTestResolver, mintTestTurnId } from './testHelpers';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The first model response calls a tool that does not exist, so the turn runs one completed step. */
async function* missingToolCallStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  const call = {
    id: 'missing-call',
    type: 'function',
    function: { name: 'missing_tool', arguments: '{}' },
  } satisfies NonNullable<RawAssistantMessageWithUsage['output']['tool_calls']>[number];
  yield {
    id: 'missing-call-chunk',
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

async function* neverAnsweringStream(
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

describe('freezing a streaming turn keeps the steps it already ran', () => {
  it('writes the completed tool step and its events before the turn is marked cancelled', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 'session-keep-steps',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });

    const modelStarted = deferred();
    let modelCalls = 0;
    const modelClient: ILLM = {
      create: jest.fn(() => {
        modelCalls += 1;
        return modelCalls === 1 ? missingToolCallStream() : neverAnsweringStream(modelStarted.resolve);
      }),
      createNonStream: jest.fn(),
    };
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'use the tool' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({ modelClient }),
    });

    const stepRan = deferred();
    const drained = (async () => {
      for await (const event of turn.stream()) {
        if (event.type === EventType.TOOL_RESPONSE_V2 || event.type === EventType.TOOL_RESPONSE) {
          stepRan.resolve();
        }
      }
    })();

    await stepRan.promise;
    await modelStarted.promise;
    await session.freezeTurn({ turn_id: turn.id, reason: CancellationReason.CancelledForNextTurn });
    await drained;

    const stored = await store.getTurn({ session_id: session.session_id, turn_id: turn.id });
    expect(stored?.state).toMatchObject({ status: 'cancelled', reason: CancellationReason.CancelledForNextTurn });
    const context = stored?.snapshot.threads['main']?.context ?? [];
    expect(context.some(message => 'role' in message && message.role === 'tool')).toBe(true);

    const { data: events } = await store.listTurnEvents({
      session_id: session.session_id,
      turn_id: turn.id,
      limit: 100,
      page_token: undefined,
      order: undefined,
    });
    const types = events.map(event => event.type);
    expect(types).toContain(EventType.TOOL_RESPONSE_V2);
    expect(types.at(-1)).toBe(TurnEventType.TURN_DONE);
  });
});

describe('freezing a finished turn whose consumer is still busy', () => {
  it('returns without waiting for the consumer and keeps the turn done', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 'session-busy-consumer',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });

    // The consumer does slow work after the terminal event, as the server does after an answer.
    const consumerBusy = deferred();
    const doneSeen = deferred();
    const drained = (async () => {
      for await (const event of turn.stream()) {
        if (event.type === TurnEventType.TURN_DONE) {
          doneSeen.resolve();
          await consumerBusy.promise;
        }
      }
    })();
    await doneSeen.promise;

    // Well under the 10 s freeze cap: the stream counts as settled once its terminal state is written.
    const startedAt = Date.now();
    const frozen = await session.freezeTurn({ turn_id: turn.id, reason: CancellationReason.CancelledForNextTurn });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(frozen.state.status).toBe('done');

    consumerBusy.resolve();
    await drained;
  });
});

describe('freezing a turn whose stream is stuck', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops waiting for the stream after 10 s and ends the turn', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 'session-stuck-stream',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });

    // The consumer stops on the first event, so the stream cannot reach its terminal write.
    const consumerStuck = deferred();
    const firstEventSeen = deferred();
    const drained = (async () => {
      for await (const _event of turn.stream()) {
        firstEventSeen.resolve();
        await consumerStuck.promise;
      }
    })();
    await firstEventSeen.promise;

    jest.useFakeTimers();
    let frozenStatus: string | undefined;
    const freezing = session
      .freezeTurn({ turn_id: turn.id, reason: CancellationReason.CancelledForNextTurn })
      .then(frozen => {
        frozenStatus = frozen.state.status;
      });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(frozenStatus).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await freezing;
    expect(frozenStatus).toBe('cancelled');

    jest.useRealTimers();
    consumerStuck.resolve();
    await drained;
  });
});
