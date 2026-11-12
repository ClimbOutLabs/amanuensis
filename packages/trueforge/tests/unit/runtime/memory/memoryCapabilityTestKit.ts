import type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  ContextMessage,
} from '@truefoundry/trueforge-core/core';
import winston from 'winston';
import type { MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import type { MemoryClient } from '../../../../src/runtime/memory/memoryClient';

export const DEFAULT_CONFIG: MemoryConfig = {
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

export function makeLogger() {
  return winston.createLogger({ silent: true });
}

export function makeClient(overrides: {
  recall?: jest.Mock;
  getOperation?: jest.Mock;
  retryOperation?: jest.Mock;
  retain?: jest.Mock;
}): MemoryClient {
  return {
    recall: overrides.recall ?? jest.fn().mockResolvedValue({ ok: true, results: [] }),
    retain: overrides.retain ?? jest.fn().mockResolvedValue({ ok: true }),
    getOperation: overrides.getOperation ?? jest.fn().mockResolvedValue({ ok: true, status: 'unknown' }),
    retryOperation: overrides.retryOperation ?? jest.fn().mockResolvedValue({ ok: true }),
    deleteDocument: jest.fn().mockResolvedValue({ ok: true }),
    listEntries: jest.fn().mockResolvedValue({ ok: true, entries: [] }),
    updateEntry: jest.fn().mockResolvedValue({ ok: false, code: 'not_found', reason: 'not used' }),
    deleteEntry: jest.fn().mockResolvedValue({ ok: true }),
  };
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
