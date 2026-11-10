import type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  ContextMessage,
} from '@truefoundry/trueforge-core/core';
import winston from 'winston';
import type { HindsightClient } from '../../../../src/runtime/memory/hindsightClient';
import type { MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';

export const DEFAULT_CONFIG: MemoryConfig = {
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
  pages: { maxCount: 6, maxTokens: 1500 },
};

export function makeLogger() {
  return winston.createLogger({ silent: true });
}

export function makeClient(overrides: {
  recall?: jest.Mock;
  getOperation?: jest.Mock;
  retryOperation?: jest.Mock;
  retain?: jest.Mock;
  getProfile?: jest.Mock;
  listMentalModels?: jest.Mock;
  reflect?: jest.Mock;
}): HindsightClient {
  return {
    recall: overrides.recall ?? jest.fn().mockResolvedValue({ ok: true, results: [], entities: [] }),
    retain: overrides.retain ?? jest.fn().mockResolvedValue({ ok: true }),
    getOperation: overrides.getOperation ?? jest.fn().mockResolvedValue({ ok: true, status: 'unknown' }),
    retryOperation: overrides.retryOperation ?? jest.fn().mockResolvedValue({ ok: true }),
    getProfile:
      overrides.getProfile ??
      jest
        .fn()
        .mockResolvedValue({ ok: true, profile: { name: undefined, mission: undefined, background: undefined } }),
    listMentalModels: overrides.listMentalModels ?? jest.fn().mockResolvedValue({ ok: true, models: [] }),
    reflect: overrides.reflect ?? jest.fn().mockResolvedValue({ ok: true, text: '', basedOn: 0 }),
  } as unknown as HindsightClient;
}

export function makeExecution(context: ContextMessage[]): Readonly<AgentThreadExecutionContext> {
  return {
    threadId: 'main',
    currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    context,
  };
}

export async function collect(gen: AsyncIterable<AgentContextProcessorOutput>): Promise<AgentContextProcessorOutput[]> {
  const events: AgentContextProcessorOutput[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}
