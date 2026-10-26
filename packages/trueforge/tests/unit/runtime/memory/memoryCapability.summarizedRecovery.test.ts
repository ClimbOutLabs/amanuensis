/**
 * With turn summaries on, a turn that saved nothing on purpose must stay unsaved. The next turn's
 * sweep must not rebuild its exchange from the chat and store it word for word.
 *
 * The config module is mocked with MEMORY_SUMMARIZE=true; summarizeTurnContent is mocked to
 * control the model outcome; the markdown client is real, against a temp directory.
 */
import type { AgentThreadExecutionContext, ContextMessage } from '@truefoundry/trueforge-core/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import winston from 'winston';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

jest.mock('../../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../../src/config')>('../../../../src/config');
  return { __esModule: true, ...actual, default: { ...actual.default, MEMORY_SUMMARIZE: true } };
});

jest.mock('../../../../src/runtime/memory/memorySummarize', () => {
  const actual = jest.requireActual<typeof import('../../../../src/runtime/memory/memorySummarize')>(
    '../../../../src/runtime/memory/memorySummarize',
  );
  return { ...actual, summarizeTurnContent: jest.fn() };
});

import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { hindsightMemoryCapability, type MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import { submitRetainWithVerification, type SummarizeTurnContext } from '../../../../src/runtime/memory/memoryRetain';
import { summarizeTurnContent } from '../../../../src/runtime/memory/memorySummarize';

const mockSummarize = jest.mocked(summarizeTurnContent);

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

const TURN = { sessionId: 's1', turnId: 't1', completedAt: '2026-10-21T12:00:00.000Z' };

function makeLogger() {
  return winston.createLogger({ silent: true });
}

function summarizeContext(): SummarizeTurnContext {
  const store: IModelProviderStore = {
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
    modelProviderStore: store,
    summarizationModelFqn: 'openai/gpt-4o',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
  };
}

function secondTurnContext(): Readonly<AgentThreadExecutionContext> {
  const context: ContextMessage[] = [
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: 'You are welcome' },
    { role: 'user', content: 'what is next?' },
  ];
  return { threadId: 'main', currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 }, context };
}

async function runSecondTurn(capability: ReturnType<typeof hindsightMemoryCapability>): Promise<void> {
  const processor = capability.preLLMProcessors?.[0];
  if (!processor) {
    throw new Error('expected a preLLM processor');
  }
  for await (const event of processor.processPreLLM(secondTurnContext())) {
    void event;
  }
}

function savedLogs(dir: string): string[] {
  const memoryDir = path.join(dir, 'tenant-1', 'memory');
  return fs.existsSync(memoryDir)
    ? fs.readdirSync(memoryDir).map(name => fs.readFileSync(path.join(memoryDir, name), 'utf8'))
    : [];
}

describe('the turn after a turn that saved nothing, with summaries on', () => {
  let dir: string;
  let client: MarkdownMemoryClient;

  beforeEach(() => {
    mockSummarize.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarized-recovery-'));
    client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function firstTurnSavesNothing(): Promise<void> {
    mockSummarize.mockResolvedValue({ status: 'nothing_to_keep' });
    await submitRetainWithVerification({
      ...TURN,
      client,
      userText: 'thanks',
      assistantText: 'You are welcome',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });
    expect(savedLogs(dir)).toEqual([]);
  }

  it('does not rebuild the exchange from the chat and save it word for word', async () => {
    await firstTurnSavesNothing();

    await runSecondTurn(
      hindsightMemoryCapability({
        client,
        config: CONFIG,
        logger: makeLogger(),
        sessionId: 's1',
        previousTurnId: 't1',
        summarize: summarizeContext(),
      }),
    );

    expect(savedLogs(dir)).toEqual([]);
    // The first turn's own answer stood: the summary model was not asked again.
    expect(mockSummarize).toHaveBeenCalledTimes(1);
  });

  it('still saves nothing when the first turn left no record, because the summary decides again', async () => {
    mockSummarize.mockResolvedValue({ status: 'nothing_to_keep' });

    await runSecondTurn(
      hindsightMemoryCapability({
        client,
        config: CONFIG,
        logger: makeLogger(),
        sessionId: 's1',
        previousTurnId: 't1',
        summarize: summarizeContext(),
      }),
    );

    expect(mockSummarize).toHaveBeenCalledTimes(1);
    expect(savedLogs(dir)).toEqual([]);
  });

  it('saves the facts of a turn whose first attempt left no record, not the exchange', async () => {
    mockSummarize.mockResolvedValue({ status: 'summarized', facts: ['The person says thanks often.'] });

    await runSecondTurn(
      hindsightMemoryCapability({
        client,
        config: CONFIG,
        logger: makeLogger(),
        sessionId: 's1',
        previousTurnId: 't1',
        summarize: summarizeContext(),
      }),
    );

    const logs = savedLogs(dir);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('The person says thanks often.');
    expect(logs[0]).not.toContain('User:');
  });
});
