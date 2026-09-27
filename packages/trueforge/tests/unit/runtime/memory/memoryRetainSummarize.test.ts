/**
 * Tests for the MEMORY_SUMMARIZE retain path.
 *
 * The config module is mocked with MEMORY_SUMMARIZE=true; the summarizeTurnContent
 * module is mocked to control the LLM outcome without network access.
 */
import winston from 'winston';
import { Writable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createMemoryClient } from '../../../../src/runtime/memory/createMemoryClient';

jest.mock('../../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../../src/config')>('../../../../src/config');
  return {
    __esModule: true,
    ...actual,
    default: { ...actual.default, MEMORY_SUMMARIZE: true },
  };
});

jest.mock('../../../../src/runtime/memory/memorySummarize', () => {
  const actual = jest.requireActual<typeof import('../../../../src/runtime/memory/memorySummarize')>(
    '../../../../src/runtime/memory/memorySummarize',
  );
  return { ...actual, summarizeTurnContent: jest.fn() };
});

import { type IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { HindsightClient, type RetainOutcome } from '../../../../src/runtime/memory/hindsightClient';
import { submitRetain, submitRetainWithVerification } from '../../../../src/runtime/memory/memoryRetain';
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

function retainingClient(): {
  client: HindsightClient;
  retain: jest.SpyInstance<Promise<RetainOutcome>, Parameters<HindsightClient['retain']>>;
} {
  const client = new HindsightClient({
    apiBase: 'https://hindsight.test.example',
    bank: 'aman',
    headers: {},
    fetchImpl: () => Promise.reject(new Error('retain tests must not reach the network')),
  });
  return { client, retain: jest.spyOn(client, 'retain') };
}

function summarizeContext() {
  return {
    tenantId: 'tenant-1',
    modelProviderStore: fakeModelProviderStore(),
    summarizationModelFqn: 'openai/gpt-4o',
  };
}

describe('submitRetain with MEMORY_SUMMARIZE=true', () => {
  beforeEach(() => {
    mockSummarize.mockReset();
  });

  it('retains the summary instead of the verbatim transcript on success', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({
      status: 'summarized',
      summary: '- User has a synthetic test robot named Bleep-Bloop.',
    });

    await submitRetain({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
      assistantText: 'Got it — Bleep-Bloop.',
      completedAt: '2026-09-19T12:00:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(mockSummarize).toHaveBeenCalledTimes(1);
    expect(mockSummarize).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
        assistantText: 'Got it — Bleep-Bloop.',
        tenantId: 'tenant-1',
        summarizationModelFqn: 'openai/gpt-4o',
      }),
    );
    const call = retain.mock.calls[0]?.[0];
    expect(call?.items[0]?.content).toBe('Turn summary: - User has a synthetic test robot named Bleep-Bloop.');
  });

  it('falls back to verbatim when summarization is skipped', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({ status: 'skipped', reason: 'empty-exchange' });

    await submitRetain({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-09-19T12:00:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    const call = retain.mock.calls[0]?.[0];
    expect(call?.items[0]?.content).toBe('User: hi\n\nAssistant: hello');
  });

  it('falls back to verbatim when summarization fails', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({ status: 'failed', reason: 'provider down' });

    await submitRetain({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-09-19T12:00:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    const call = retain.mock.calls[0]?.[0];
    expect(call?.items[0]?.content).toBe('User: hi\n\nAssistant: hello');
  });

  it('falls back to verbatim when summarization throws', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockRejectedValue(new Error('should be caught inside'));

    await submitRetain({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-09-19T12:00:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    // The retain itself never throws; the memory is preserved verbatim.
    const call = retain.mock.calls[0]?.[0];
    expect(call?.items[0]?.content).toBe('User: hi\n\nAssistant: hello');
  });

  it('does not summarize when no summarize context is provided (verbatim default)', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });

    await submitRetain({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-09-19T12:00:00.000Z',
      logger: makeLogger(),
    });

    expect(mockSummarize).not.toHaveBeenCalled();
    const call = retain.mock.calls[0]?.[0];
    expect(call?.items[0]?.content).toBe('User: hi\n\nAssistant: hello');
  });
});

describe('submitRetainWithVerification with MEMORY_SUMMARIZE=true', () => {
  beforeEach(() => {
    mockSummarize.mockReset();
  });

  it('invokes the summarizer exactly once across submission and verification resubmission', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    // The verification pass sees a vanished operation and resubmits once.
    const getOperation = jest.spyOn(client, 'getOperation').mockResolvedValue({ ok: true, status: 'unknown' });
    mockSummarize.mockResolvedValue({
      status: 'summarized',
      summary: '- User has a synthetic test robot named Bleep-Bloop.',
    });

    await submitRetainWithVerification({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
      assistantText: 'Got it.',
      completedAt: '2026-09-19T12:00:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    // Submission plus the verification resubmission...
    expect(retain).toHaveBeenCalledTimes(2);
    // ...but the summary was computed once and reused, never recomputed.
    expect(mockSummarize).toHaveBeenCalledTimes(1);
    // Both submissions carried the same precomputed summary.
    for (const call of retain.mock.calls) {
      expect(call[0]?.items[0]?.content).toBe('Turn summary: - User has a synthetic test robot named Bleep-Bloop.');
    }
    getOperation.mockRestore();
  });
});

describe('summarization observability', () => {
  function capturingLogger(): { logger: winston.Logger; lines: string[] } {
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

  function baseSubmit(logger: winston.Logger) {
    return {
      client: retainingClient().client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'Please remember that my houseplant is a cactus named Gerald.',
      assistantText: 'Noted: Gerald the cactus.',
      completedAt: '2026-09-21T12:00:00.000Z',
      logger,
    };
  }

  beforeEach(() => {
    mockSummarize.mockReset();
  });

  it('logs when a turn is summarized instead of stored verbatim', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({ status: 'summarized', summary: '- Houseplant is a cactus named Gerald.' });
    const { logger, lines } = capturingLogger();

    await submitRetain({ ...baseSubmit(logger), client, summarize: summarizeContext() });

    expect(lines.some(line => line.includes('Turn summarized'))).toBe(true);
  });

  it('logs the skip reason when summarization is skipped', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({ status: 'skipped', reason: 'no-model-configured' });
    const { logger, lines } = capturingLogger();

    await submitRetain({ ...baseSubmit(logger), client, summarize: summarizeContext() });

    expect(lines.some(line => line.includes('Memory summarization skipped'))).toBe(true);
    expect(lines.some(line => line.includes('no-model-configured'))).toBe(true);
  });

  it('logs when summarization fails and falls back to verbatim', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({ status: 'failed', reason: 'provider down' });
    const { logger, lines } = capturingLogger();

    await submitRetain({ ...baseSubmit(logger), client, summarize: summarizeContext() });

    expect(lines.some(line => line.includes('Memory summarization failed'))).toBe(true);
  });

  it('logs when no summarization context was provided for the turn', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    const { logger, lines } = capturingLogger();

    await submitRetain({ ...baseSubmit(logger), client });

    expect(mockSummarize).not.toHaveBeenCalled();
    expect(lines.some(line => line.includes('context not provided'))).toBe(true);
  });
});

describe('markdown round trip (synthetic end-to-end)', () => {
  beforeEach(() => {
    mockSummarize.mockReset();
  });

  it('stores a Turn summary entry in the Markdown file and recalls it in a fresh context', async () => {
    mockSummarize.mockResolvedValue({
      status: 'summarized',
      summary: '- Houseplant is a cactus named Gerald.',
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-e2e-'));
    const client = createMemoryClient({
      backend: 'markdown',
      markdownDir: dir,
      namespace: 'tenant-1',
      hindsight: undefined,
    });
    if (client === undefined) {
      throw new Error('expected a markdown memory client');
    }

    // Drive the real retain path: summarize -> buildRetainItem -> markdown file.
    await submitRetainWithVerification({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'Please remember that my houseplant is a cactus named Gerald.',
      assistantText: 'Noted: Gerald the cactus.',
      completedAt: '2026-09-21T12:00:00.000Z',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    // The Markdown file carries a Turn summary entry, not the verbatim transcript.
    const memoryDir = path.join(dir, 'tenant-1', 'memory');
    const files = fs.readdirSync(memoryDir).filter(name => name.endsWith('.md'));
    expect(files).toHaveLength(1);
    const firstFile = files[0];
    if (firstFile === undefined) {
      throw new Error('expected one daily memory file');
    }
    const content = fs.readFileSync(path.join(memoryDir, firstFile), 'utf8');
    expect(content).toContain('Turn summary:');
    expect(content).toContain('Gerald');
    expect(content).not.toContain('User: Please remember');

    // Fresh-context recall finds the remembered fact.
    const freshClient = createMemoryClient({
      backend: 'markdown',
      markdownDir: dir,
      namespace: 'tenant-1',
      hindsight: undefined,
    });
    if (freshClient === undefined) {
      throw new Error('expected a markdown memory client');
    }
    const recallOutcome = await freshClient.recall({
      query: 'What is my houseplant named?',
      maxTokens: 2000,
      queryTimestamp: '2026-09-21T12:01:00.000Z',
      entityTokens: 0,
      timeoutMs: 5000,
    });
    if (!recallOutcome.ok) {
      throw new Error(`recall failed: ${recallOutcome.reason}`);
    }
    const recalledText = recallOutcome.results.map(item => item.text).join('\n');
    expect(recalledText).toContain('Gerald');
  });
});
