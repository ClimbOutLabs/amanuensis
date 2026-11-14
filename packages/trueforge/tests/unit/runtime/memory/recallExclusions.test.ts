/**
 * Pulling a fact out of a chat from the right rail: the fact leaves that chat's recall from
 * the next turn on, and stays recalled in every other chat. The memory itself is untouched:
 * the same client keeps returning the fact, and only the session's exclusion list stops it.
 */
import type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  ContextMessage,
} from '@truefoundry/trueforge-core/core';
import { InternalEventType } from '@truefoundry/trueforge-core/core';
import winston from 'winston';

import { memoryCapability, type MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import type { MemoryClient } from '../../../../src/runtime/memory/memoryClient';

/** The facts each chat has pulled out of its recall, as the stored read returns them. */
const pulledByChat = new Map<string, string[]>();

/** Records a pull the way the endpoint stores it with the chat. */
function pullFact(sessionId: string, factText: string): void {
  pulledByChat.set(sessionId, [...(pulledByChat.get(sessionId) ?? []), factText]);
}

const CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  pages: { maxCount: 6, maxTokens: 1500 },
};

const FACT = 'The gate code is 4417';

/** A memory client that always recalls the one fact, as the vault would until it is edited. */
function makeClient(): MemoryClient {
  return {
    recall: () =>
      Promise.resolve({
        ok: true,
        results: [{ id: '1', occurred_start: '2026-08-14', text: FACT }],
      }),
    retain: () => Promise.resolve({ ok: true }),
    deleteDocument: () => Promise.resolve({ ok: true }),
    getOperation: () => Promise.resolve({ ok: true, status: 'unknown' }),
    retryOperation: () => Promise.resolve({ ok: true }),
    listEntries: () => Promise.resolve({ ok: true, entries: [] }),
    updateEntry: params =>
      Promise.resolve({
        ok: true,
        entry: { id: params.entryId, text: params.text, timestamp: '2026-08-14T00:00:00.000Z', persona: null },
      }),
    deleteEntry: () => Promise.resolve({ ok: true }),
  };
}

function makeExecution(context: ContextMessage[]): Readonly<AgentThreadExecutionContext> {
  return {
    threadId: 'main',
    currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    context,
  };
}

/** One turn's recall block for a chat, through a fresh capability as a new turn builds. */
async function recallBlockFor(sessionId: string): Promise<string | null> {
  return recallBlockServing(sessionId, [FACT], makeClient());
}

/** The block one turn builds from the given memory client. */
async function blockFrom(capability: ReturnType<typeof memoryCapability>): Promise<string | null> {
  const processor = capability.preLLMProcessors?.[0];
  if (processor === undefined) {
    throw new Error('expected a preLLM processor');
  }
  const events: AgentContextProcessorOutput[] = [];
  for await (const event of processor.processPreLLM(
    makeExecution([{ role: 'user', content: 'what is the gate code' }]),
  )) {
    events.push(event);
  }
  const found = events.find(event => event.type === InternalEventType.PASSTHROUGH);
  if (
    found === undefined ||
    found.type !== InternalEventType.PASSTHROUGH ||
    found.event.type !== 'aman.memory.recall'
  ) {
    throw new Error('expected an aman.memory.recall passthrough event');
  }
  return found.event.injected_block;
}

describe('recall exclusions from the rail', () => {
  it('drops the pulled fact from that chat only, from the next turn on', async () => {
    expect(await recallBlockFor('chat-a')).toContain(FACT);

    pullFact('chat-a', FACT);

    const afterPull = await recallBlockFor('chat-a');
    expect(afterPull === null || !afterPull.includes(FACT)).toBe(true);
    expect(await recallBlockFor('chat-b')).toContain(FACT);
  });
});

const LONG_FACT = 'The gate code for the front door is 4417 and the spare key is under the mat';
/** The same fact cut short for a token budget, the way the block's own fitting ends a line. */
const SHORTENED_FACT = `${LONG_FACT.slice(0, 40)}...`;

/** A memory client that recalls the given facts, in order. */
function makeClientReturning(texts: string[]): MemoryClient {
  return {
    ...makeClient(),
    recall: () =>
      Promise.resolve({
        ok: true,
        results: texts.map((text, index) => ({ id: String(index), occurred_start: '2026-08-14', text })),
      }),
  };
}

/** One turn's recall block for a chat whose memory serves the given facts. */
async function recallBlockServing(
  sessionId: string,
  texts: string[],
  client: MemoryClient = makeClientReturning(texts),
): Promise<string | null> {
  return blockFrom(
    memoryCapability({
      client,
      config: CONFIG,
      logger: winston.createLogger({ silent: true }),
      sessionId,
      previousTurnId: null,
      loadRecallExclusions: () => Promise.resolve(pulledByChat.get(sessionId) ?? []),
    }),
  );
}

describe('recall exclusions for facts shown shortened', () => {
  it('drops the full fact when the pull was recorded in its shortened form', async () => {
    expect(await recallBlockServing('chat-short-pull', [LONG_FACT])).toContain(LONG_FACT);

    pullFact('chat-short-pull', SHORTENED_FACT);

    const afterPull = await recallBlockServing('chat-short-pull', [LONG_FACT]);
    expect(afterPull === null || !afterPull.includes('spare key')).toBe(true);
  });

  it('drops a shortened serving when the pull was recorded in full', async () => {
    pullFact('chat-full-pull', LONG_FACT);

    const afterPull = await recallBlockServing('chat-full-pull', [SHORTENED_FACT]);
    expect(afterPull === null || !afterPull.includes('gate code')).toBe(true);
  });

  it('leaves a different fact that merely opens with the same words', async () => {
    const other = 'The gate code is 44179 for the back gate';
    pullFact('chat-neighbour', FACT);

    const block = await recallBlockServing('chat-neighbour', [FACT, other]);
    expect(block).toContain(other);
    // The pulled fact's own line is gone; the other fact's line only shares its opening words.
    expect(block?.split('\n').some(line => line.endsWith(`] ${FACT}`))).toBe(false);
  });

  it('does not trust a shortening cut too short to name the fact', async () => {
    pullFact('chat-short-stem', 'The gate...');

    const block = await recallBlockServing('chat-short-stem', [LONG_FACT]);
    expect(block).toContain(LONG_FACT);
  });
});
