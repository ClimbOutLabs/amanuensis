/**
 * Tests for the summary-pending marker the retain path leaves behind.
 *
 * When a turn's summary attempt fails, nothing is saved, and the vault is marked as owed a
 * summary so the Memories page can show that a summary is missing instead of staying silent.
 * The next chat with that agent runs the summary job again; a success stores the facts and
 * clears the mark.
 *
 * summarizeTurnContent is mocked to control the model outcome without network access;
 * the markdown client is real, against a temp directory.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import winston from 'winston';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

jest.mock('../../../../src/runtime/memory/memorySummarize', () => {
  const actual = jest.requireActual<typeof import('../../../../src/runtime/memory/memorySummarize')>(
    '../../../../src/runtime/memory/memorySummarize',
  );
  return { ...actual, summarizeTurnContent: jest.fn() };
});

import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { HindsightClient } from '../../../../src/runtime/memory/hindsightClient';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { submitRetain } from '../../../../src/runtime/memory/memoryRetain';
import { summarizeTurnContent } from '../../../../src/runtime/memory/memorySummarize';

const mockSummarize = jest.mocked(summarizeTurnContent);

function makeLogger() {
  return winston.createLogger({ silent: true });
}

/** Minimal fake; the mocked summarizeTurnContent never dereferences the store. */
function fakeModelProviderStore(): IModelProviderStore {
  return {
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
  };
}

function summarizeContext() {
  return {
    tenantId: 'tenant-1',
    modelProviderStore: fakeModelProviderStore(),
    summarizationModelFqn: 'local/slow-model',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
  };
}

describe('submitRetain summary-pending marker', () => {
  let baseDir: string;
  let zaraClient: MarkdownMemoryClient;
  let reader: MarkdownMemoryClient;

  beforeEach(async () => {
    mockSummarize.mockReset();
    baseDir = await mkdtemp(join(tmpdir(), 'summary-pending-'));
    zaraClient = new MarkdownMemoryClient({
      baseDir,
      namespace: 'tenant-1',
      vaultScope: { personaName: 'Zara', personaId: 'p-zara' },
    });
    reader = new MarkdownMemoryClient({ baseDir, namespace: 'tenant-1' });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('marks the vault when a summary fails, and the next chat retries and clears the mark', async () => {
    mockSummarize.mockResolvedValue({
      status: 'failed',
      reason: 'The model timed out',
      fallback: 'model_timeout',
    });

    await submitRetain({
      client: zaraClient,
      sessionId: 's1',
      turnId: 't1',
      userText: 'Please remember that my test robot is named Bleep-Bloop.',
      assistantText: 'Got it, Bleep-Bloop.',
      completedAt: '2026-10-20T12:00:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    // Nothing is saved: neither the person's words nor the reply.
    const afterFailure = await reader.listEntries({ namespace: 'persona:Zara', timeoutMs: 5_000 });
    expect(afterFailure.ok && afterFailure.entries).toEqual([]);
    // The failure is not silent: Zara's vault is marked as owed a summary, and no
    // other vault is marked.
    expect(await reader.summaryPending({ namespace: 'persona:Zara' })).toBe(true);
    expect(await reader.summaryPending({ namespace: '' })).toBe(false);

    // The next chat with Zara runs the summary job again; this time it succeeds, the
    // summary is stored, and the mark clears.
    mockSummarize.mockResolvedValue({ status: 'summarized', facts: ['The test robot is named Bleep-Bloop.'] });
    await submitRetain({
      client: zaraClient,
      sessionId: 's1',
      turnId: 't2',
      userText: 'Please remember that my test robot is named Bleep-Bloop.',
      assistantText: 'Got it, Bleep-Bloop.',
      completedAt: '2026-10-20T12:05:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(mockSummarize).toHaveBeenCalledTimes(2);
    const afterRetry = await reader.listEntries({ namespace: 'persona:Zara', timeoutMs: 5_000 });
    expect(afterRetry.ok).toBe(true);
    if (afterRetry.ok) {
      expect(afterRetry.entries.some(entry => entry.text.includes('The test robot is named Bleep-Bloop.'))).toBe(true);
    }
    expect(await reader.summaryPending({ namespace: 'persona:Zara' })).toBe(false);
  });

  it('does not mark the vault for a deliberate skip (an overlong turn is left alone)', async () => {
    mockSummarize.mockResolvedValue({ status: 'skipped', reason: 'input-too-long' });

    await submitRetain({
      client: zaraClient,
      sessionId: 's1',
      turnId: 't1',
      userText: 'A very long story.',
      assistantText: 'A very long answer.',
      completedAt: '2026-10-20T12:00:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(await reader.summaryPending({ namespace: 'persona:Zara' })).toBe(false);
  });

  it('stores nothing, and does not fail, on a client without summary tracking when a summary fails', async () => {
    const client = new HindsightClient({
      apiBase: 'https://hindsight.test.example',
      bank: 'aman',
      headers: {},
      fetchImpl: () => Promise.reject(new Error('summary pending tests must not reach the network')),
    });
    const retain = jest.spyOn(client, 'retain').mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({ status: 'failed', reason: 'boom', fallback: 'model_failed' });

    await submitRetain({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'Please remember that my test robot is named Bleep-Bloop.',
      assistantText: 'Got it, Bleep-Bloop.',
      completedAt: '2026-10-20T12:00:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(retain).not.toHaveBeenCalled();
  });
});
