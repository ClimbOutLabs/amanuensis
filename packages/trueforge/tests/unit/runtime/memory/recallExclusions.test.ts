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

import { hindsightMemoryCapability, type MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import type { MemoryClient } from '../../../../src/runtime/memory/memoryClient';
import { excludeRecallFact } from '../../../../src/runtime/memory/recallExclusions';

const CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallEntityTokens: 512,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  recallMaxEntities: 8,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  curated: { enabled: false, maxModels: 3, maxTokens: 512 },
  reflect: { enabled: false, budget: 'low', maxTokens: 512, timeoutMs: 8000 },
};

const FACT = 'The gate code is 4417';

/** A memory client that always recalls the one fact, as the vault would until it is edited. */
function makeClient(): MemoryClient {
  return {
    recall: () =>
      Promise.resolve({
        ok: true,
        results: [{ id: '1', occurred_start: '2026-08-14', text: FACT }],
        entities: [],
      }),
    retain: () => Promise.resolve({ ok: true }),
    deleteDocument: () => Promise.resolve({ ok: true }),
    getOperation: () => Promise.resolve({ ok: true, status: 'unknown' }),
    retryOperation: () => Promise.resolve({ ok: true }),
    getProfile: () =>
      Promise.resolve({ ok: true, profile: { name: undefined, mission: undefined, background: undefined } }),
    listMentalModels: () => Promise.resolve({ ok: true, models: [] }),
    reflect: () => Promise.resolve({ ok: true, text: '', basedOn: 0 }),
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
  const capability = hindsightMemoryCapability({
    client: makeClient(),
    config: CONFIG,
    logger: winston.createLogger({ silent: true }),
    sessionId,
    previousTurnId: null,
  });
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

    excludeRecallFact({ sessionId: 'chat-a', factText: FACT });

    const afterPull = await recallBlockFor('chat-a');
    expect(afterPull === null || !afterPull.includes(FACT)).toBe(true);
    expect(await recallBlockFor('chat-b')).toContain(FACT);
  });
});
