import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { MAIN_THREAD_ID } from '../../src/agent-session/models/TurnRecord';
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import type { TurnStreamingEvent } from '../../src/agent-session/TurnHandle';
import type {
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
} from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import {
  makeAgentSpec,
  makeMockILLM,
  makeTestResolver,
  mintTestTurnId,
} from './testHelpers';

/**
 * TurnHandle's knowledge-attribution repair surface:
 * - assistant text entering the durable thread context passes through the
 *   host's sanitizeAssistantTextForContext hook (markers never persist);
 * - when finalizeAssistantOutput repairs the terminal message, the repaired
 *   model.message is re-published (same id) before turn.done so
 *   delta-folding live clients converge on the repaired content.
 */

const RAW_WITH_MARKER = 'Giant pandas ⟦src:1⟧ eat bamboo.';
const REPAIRED = 'Giant pandas [src] eat bamboo.';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* markerTerminalStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: RAW_WITH_MARKER }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: RAW_WITH_MARKER },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function isModelMessage(
  event: TurnStreamingEvent,
): event is Extract<TurnStreamingEvent, { type: typeof EventType.MODEL_MESSAGE }> {
  return event.type === EventType.MODEL_MESSAGE;
}

async function createSession() {
  const store = new InMemorySessionStore();
  const sessions = new Sessions({ sessionStore: store });
  const session = await sessions.create({
    tenant_id: 'tenant-1',
    session_id: 's1',
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    agent: {
      type: 'inline',
      spec: makeAgentSpec(),
    },
    external_id: null,
  });
  return { store, session };
}

function scriptedResolver(options?: {
  finalizeAssistantOutput?: ITurnResourceResolver['finalizeAssistantOutput'];
  sanitizeAssistantTextForContext?: ITurnResourceResolver['sanitizeAssistantTextForContext'];
}) {
  return makeTestResolver({
    modelClient: makeMockILLM({ create: jest.fn().mockImplementation(() => markerTerminalStream()) }),
    ...(options?.finalizeAssistantOutput === undefined
      ? {}
      : { finalizeAssistantOutput: options.finalizeAssistantOutput }),
    ...(options?.sanitizeAssistantTextForContext === undefined
      ? {}
      : { sanitizeAssistantTextForContext: options.sanitizeAssistantTextForContext }),
  });
}

async function persistedAssistantTexts(
  store: InMemorySessionStore,
  turnId: string,
): Promise<string[]> {
  const stored = await store.getTurn({ session_id: 's1', turn_id: turnId });
  const context = stored?.snapshot.threads[MAIN_THREAD_ID]?.context ?? [];
  return context.flatMap(message =>
    'role' in message && message.role === 'assistant' && typeof message.content === 'string'
      ? [message.content]
      : [],
  );
}

describe('TurnHandle knowledge-attribution repair', () => {
  it('sanitizes assistant text at the durable thread-context boundary', async () => {
    const { store, session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: scriptedResolver({
        sanitizeAssistantTextForContext: text => text.replace(/⟦src:\d+⟧/g, '[src]'),
      }),
    });

    const events: TurnStreamingEvent[] = [];
    for await (const event of turn.stream()) {
      events.push(event);
    }
    expect(turn.state.status).toBe('done');

    // The live stream is untouched: deltas still carry the raw marker for
    // this turn's own rendering.
    const deltas = events.filter(event => event.type === EventType.MODEL_MESSAGE_DELTA);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.some(event => JSON.stringify(event).includes('⟦src:1⟧'))).toBe(true);

    // The durable copy — what turn N+1's transcript will see — is sanitized.
    const persisted = await persistedAssistantTexts(store, turn.id);
    expect(persisted).toContain(REPAIRED);
    expect(persisted.every(text => !text.includes('⟦src:'))).toBe(true);
  });

  it('keeps the original context when the sanitizer throws', async () => {
    const { store, session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: scriptedResolver({
        sanitizeAssistantTextForContext: () => {
          throw new Error('boom');
        },
      }),
    });

    for await (const event of turn.stream()) {
      void event;
    }
    expect(turn.state.status).toBe('done');

    // Sanitization can never fail the turn: the original text persists.
    const persisted = await persistedAssistantTexts(store, turn.id);
    expect(persisted).toContain(RAW_WITH_MARKER);
  });

  it('re-publishes the repaired terminal model.message (same id) before turn.done', async () => {
    const { session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: scriptedResolver({
        finalizeAssistantOutput: output => ({ ...output, content: REPAIRED }),
      }),
    });

    const events: TurnStreamingEvent[] = [];
    for await (const event of turn.stream()) {
      events.push(event);
    }

    const modelMessages = events.filter(isModelMessage);
    expect(modelMessages).toHaveLength(2);
    const [start, repaired] = modelMessages;
    // Delta streams open with a content-less model.message carrying the id…
    expect(start?.content).toBeUndefined();
    // …and the repaired terminal event reuses that same id, immediately
    // before turn.done, so delta-folding clients replace the folded raw
    // content with the repaired text.
    expect(repaired?.id).toBe(start?.id);
    expect(repaired?.content).toBe(REPAIRED);
    expect(events[events.length - 2]).toBe(repaired);
    expect(events[events.length - 1]?.type).toBe(EventType.TURN_DONE);

    // The turn record carries the repaired content.
    expect(turn.state.status).toBe('done');
    if (turn.state.status === 'done') {
      expect(turn.state.output?.content).toBe(REPAIRED);
    }
  });

  it('does not re-publish the terminal message when the post-pass leaves it unchanged', async () => {
    const { session } = await createSession();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: scriptedResolver({
        finalizeAssistantOutput: () => undefined,
      }),
    });

    const events: TurnStreamingEvent[] = [];
    for await (const event of turn.stream()) {
      events.push(event);
    }

    const modelMessages = events.filter(isModelMessage);
    expect(modelMessages).toHaveLength(1);
    expect(modelMessages[0]?.content).toBeUndefined();
    expect(events[events.length - 1]?.type).toBe(EventType.TURN_DONE);
  });
});
