/**
 * End to end across two chats with a real markdown store: a chat that builds a space while the
 * assistant narrates its steps must leave nothing of those steps for the next chat to recall.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { submitRetain } from '../../../../src/runtime/memory/memoryRetain';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

jest.mock('../../../../src/runtime/memory/memorySummarize', () => {
  const actual = jest.requireActual<typeof import('../../../../src/runtime/memory/memorySummarize')>(
    '../../../../src/runtime/memory/memorySummarize',
  );
  // Runs the real summarizer against a scripted model that keeps the assistant's narration.
  return {
    ...actual,
    summarizeTurnContent: jest.fn(params =>
      actual.summarizeTurnContent({
        ...params,
        resolveLlm: async () => ({
          create: () => {
            throw new Error('streaming is not used');
          },
          createNonStream: async () => ({
            output: {
              role: 'assistant' as const,
              content: JSON.stringify({
                facts: [
                  'Maya wants to insert ranks 18-20 after rank 17.',
                  'Maya needs to perform the inserts in separate chunks due to character limit.',
                  "Maya's mechanic is Sidd.",
                ],
              }),
            },
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            finish_reason: 'stop' as const,
          }),
        }),
      }),
    ),
  };
});

const unusedStore: IModelProviderStore = {
  listProviders: jest.fn(),
  getProvider: jest.fn(),
  getProviderForUpdate: jest.fn(),
  createProvider: jest.fn(),
  upsertProvider: jest.fn(),
  listModels: jest.fn(),
  deleteProvider: jest.fn(),
};

describe('memory across chats', () => {
  it('carries nothing from the steps of a space build into the next chat', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mdmem-e2e-'));
    try {
      const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });

      await submitRetain({
        client,
        sessionId: 'chat-1',
        turnId: 't1',
        userText: 'make the dog table, and my mechanic is Sidd',
        assistantText:
          "I'll insert ranks 18-20 after rank 17, then ranks 21-30. I need to do the inserts in separate chunks.",
        completedAt: '2026-10-28T12:00:00.000Z',
        logger: winston.createLogger({ silent: true }),
        summarize: {
          tenantId: 'tenant-1',
          modelProviderStore: unusedStore,
          summarizationModelFqn: 'openai/gpt-4o',
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          modelUsage: discardedModelUsage,
          personName: 'Maya',
        },
      });

      const recall = await client.recall({
        query: 'ranks insert chunks table mechanic bill',
        maxTokens: 4000,
        queryTimestamp: '2026-10-29T09:00:00.000Z',
        entityTokens: 0,
        timeoutMs: 1000,
        currentSessionId: 'chat-2',
      });
      if (!recall.ok) {
        throw new Error(recall.reason);
      }
      const recalled = recall.results.map(item => item.text).join('\n');

      expect(recalled).toContain('Sidd');
      expect(recalled).not.toMatch(/ranks|chunks|insert/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
