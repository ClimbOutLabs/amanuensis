/**
 * Tests for the MEMORY_SUMMARIZE retain path.
 *
 * The config module is mocked with MEMORY_SUMMARIZE=true; the summarizeTurnContent
 * module is mocked to control the LLM outcome without network access.
 *
 * The rule under test: with summarization on, the exchange is never stored. Durable facts are
 * stored, and "nothing durable", a failed summary, or an unsummarized turn stores nothing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import winston from 'winston';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

import { createMemoryClient } from '../../../../src/runtime/memory/createMemoryClient';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';

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

import type { ILLM } from '@truefoundry/trueforge-core/core';
import { type IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { HindsightClient, type RetainOutcome } from '../../../../src/runtime/memory/hindsightClient';
import type { MemoryClient } from '../../../../src/runtime/memory/memoryClient';
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
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
  };
}

const TURN = {
  sessionId: 's1',
  turnId: 't1',
  completedAt: '2026-09-19T12:00:00.000Z',
};

describe('submitRetain with MEMORY_SUMMARIZE=true', () => {
  beforeEach(() => {
    mockSummarize.mockReset();
  });

  it('retains the facts as plain text, not the transcript, on success', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({
      status: 'summarized',
      facts: ['The person has a synthetic test robot named Bleep-Bloop.'],
    });

    await submitRetain({
      ...TURN,
      client,
      userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
      assistantText: 'Got it — Bleep-Bloop.',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(mockSummarize).toHaveBeenCalledTimes(1);
    expect(mockSummarize).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
        assistantText: 'Got it — Bleep-Bloop.',
        turnDate: '2026-09-19T12:00:00.000Z',
        tenantId: 'tenant-1',
        summarizationModelFqn: 'openai/gpt-4o',
      }),
    );
    expect(retain.mock.calls[0]?.[0]?.items[0]?.content).toBe(
      'The person has a synthetic test robot named Bleep-Bloop.',
    );
  });

  it('stores several facts as short bullet lines in one entry', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({
      status: 'summarized',
      facts: ["The person's friend Harry has their book.", 'The person needs the car back on 2026-09-20.'],
    });

    await submitRetain({
      ...TURN,
      client,
      userText: 'My friend Harry has my book. I need the car back tomorrow.',
      assistantText: 'Noted.',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(retain).toHaveBeenCalledTimes(1);
    expect(retain.mock.calls[0]?.[0]?.items).toHaveLength(1);
    expect(retain.mock.calls[0]?.[0]?.items[0]?.content).toBe(
      "- The person's friend Harry has their book.\n- The person needs the car back on 2026-09-20.",
    );
  });

  it('stores nothing when the turn holds nothing worth keeping', async () => {
    const { client, retain } = retainingClient();
    mockSummarize.mockResolvedValue({ status: 'nothing_to_keep' });

    await submitRetain({
      ...TURN,
      client,
      userText: 'Dog',
      assistantText: 'Noted. Anything else on your mind?',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(retain).not.toHaveBeenCalled();
  });

  it('stores nothing for an empty exchange', async () => {
    const { client, retain } = retainingClient();
    mockSummarize.mockResolvedValue({ status: 'skipped', reason: 'empty-exchange' });

    await submitRetain({
      ...TURN,
      client,
      userText: '',
      assistantText: '',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(retain).not.toHaveBeenCalled();
  });

  it.each([
    ['fails', { status: 'failed', reason: 'provider down', fallback: 'model_failed' }],
    [
      'is cut off by its length limit',
      { status: 'failed', reason: 'summary-cut-short', fallback: 'summary_cut_short' },
    ],
    ['is skipped for a missing model', { status: 'skipped', reason: 'no-model-configured' }],
    ['is skipped for a long input', { status: 'skipped', reason: 'input-too-long' }],
  ] as const)('stores nothing, not the chat text, when summarization %s', async (_name, result) => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue(result);

    await submitRetain({
      ...TURN,
      client,
      userText: 'My friend Harry has my book and I want it back by Friday.',
      assistantText: 'Sure, I can help you word a reminder for Harry.',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(retain).not.toHaveBeenCalled();
  });

  it('stores nothing when summarization throws', async () => {
    const { client, retain } = retainingClient();
    mockSummarize.mockRejectedValue(new Error('should be caught inside'));

    await submitRetain({
      ...TURN,
      client,
      userText: 'yes',
      assistantText: 'hello',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    expect(retain).not.toHaveBeenCalled();
  });

  it('does not summarize when no summarize context is provided (the exchange is kept for the backend)', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });

    await submitRetain({
      ...TURN,
      client,
      userText: 'hi',
      assistantText: 'hello',
      logger: makeLogger(),
    });

    expect(mockSummarize).not.toHaveBeenCalled();
    expect(retain.mock.calls[0]?.[0]?.items[0]?.content).toBe('User: hi\n\nAssistant: hello');
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
      facts: ['The person has a synthetic test robot named Bleep-Bloop.'],
    });

    await submitRetainWithVerification({
      ...TURN,
      client,
      userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
      assistantText: 'Got it.',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });

    // Submission plus the verification resubmission...
    expect(retain).toHaveBeenCalledTimes(2);
    // ...but the summary was computed once and reused, never recomputed.
    expect(mockSummarize).toHaveBeenCalledTimes(1);
    for (const call of retain.mock.calls) {
      expect(call[0]?.items[0]?.content).toBe('The person has a synthetic test robot named Bleep-Bloop.');
    }
    getOperation.mockRestore();
  });

  it('reports that nothing was stored when there was nothing to keep', async () => {
    const { client, retain } = retainingClient();
    const getOperation = jest.spyOn(client, 'getOperation');
    mockSummarize.mockResolvedValue({ status: 'nothing_to_keep' });

    await expect(
      submitRetainWithVerification({
        ...TURN,
        client,
        userText: 'Dog',
        assistantText: 'Noted.',
        logger: makeLogger(),
        summarize: summarizeContext(),
      }),
    ).resolves.toBe(false);
    expect(retain).not.toHaveBeenCalled();
    expect(getOperation).not.toHaveBeenCalled();
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
      ...TURN,
      client: retainingClient().client,
      userText: 'Please remember that my houseplant is a cactus named Gerald.',
      assistantText: 'Noted: Gerald the cactus.',
      completedAt: '2026-09-21T12:00:00.000Z',
      logger,
    };
  }

  beforeEach(() => {
    mockSummarize.mockReset();
  });

  it('logs when a turn is summarized instead of stored as an exchange', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({ status: 'summarized', facts: ['The person has a cactus named Gerald.'] });
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

  it('logs when summarization fails', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({ status: 'failed', reason: 'provider down', fallback: 'model_failed' });
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

  function markdownClient(dir: string): MemoryClient {
    const client = createMemoryClient({
      backend: 'markdown',
      markdownDir: dir,
      namespace: 'tenant-1',
      hindsight: undefined,
    });
    if (client === undefined) {
      throw new Error('expected a markdown memory client');
    }
    return client;
  }

  it('stores a clean fact entry in the Markdown file and recalls it in a fresh context', async () => {
    mockSummarize.mockResolvedValue({
      status: 'summarized',
      facts: ['The person has a houseplant, a cactus named Gerald.'],
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-e2e-'));
    try {
      await submitRetainWithVerification({
        ...TURN,
        client: markdownClient(dir),
        userText: 'Please remember that my houseplant is a cactus named Gerald.',
        assistantText: 'Noted: Gerald the cactus.',
        completedAt: '2026-09-21T12:00:00.000Z',
        logger: makeLogger(),
        summarize: summarizeContext(),
      });

      const memoryDir = path.join(dir, 'tenant-1', 'memory');
      const files = fs.readdirSync(memoryDir).filter(name => name.endsWith('.md'));
      expect(files).toHaveLength(1);
      const content = fs.readFileSync(path.join(memoryDir, files[0] ?? ''), 'utf8');
      // The entry format recall relies on: heading with the time, the fact text, a hidden chat id.
      expect(content).toBe(
        '## 2026-09-21T12:00:00.000Z\n\nThe person has a houseplant, a cactus named Gerald.\n\n<!-- session_id: s1 -->\n\n',
      );
      expect(content).not.toContain('Turn summary');
      expect(content).not.toContain('Chat title');
      expect(content).not.toContain('User:');

      const recallOutcome = await markdownClient(dir).recall({
        query: 'What is my houseplant named?',
        maxTokens: 2000,
        queryTimestamp: '2026-09-21T12:01:00.000Z',
        entityTokens: 0,
        timeoutMs: 5000,
      });
      if (!recallOutcome.ok) {
        throw new Error(`recall failed: ${recallOutcome.reason}`);
      }
      const recalled = recallOutcome.results.map(item => item.text).join('\n');
      expect(recalled).toContain('Gerald');
      expect(recalled).not.toContain('session_id');
      expect(recallOutcome.results[0]?.metadata?.['session_id']).toBe('s1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing to disk when the turn holds nothing worth keeping', async () => {
    mockSummarize.mockResolvedValue({ status: 'nothing_to_keep' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-nothing-'));
    try {
      await submitRetainWithVerification({
        ...TURN,
        client: markdownClient(dir),
        userText: 'Dog',
        assistantText: 'Noted. Anything else on your mind?',
        logger: makeLogger(),
        summarize: summarizeContext(),
      });
      expect(fs.existsSync(path.join(dir, 'tenant-1', 'memory'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes no chat text to disk when the summary fails', async () => {
    mockSummarize.mockResolvedValue({ status: 'failed', reason: 'summary-cut-short', fallback: 'summary_cut_short' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-failed-'));
    try {
      await submitRetainWithVerification({
        ...TURN,
        client: markdownClient(dir),
        userText: 'Please remember that my houseplant is a cactus named Gerald.',
        assistantText: 'Noted: Gerald the cactus.',
        logger: makeLogger(),
        summarize: summarizeContext(),
      });
      expect(fs.existsSync(path.join(dir, 'tenant-1', 'memory'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a summary model that reasons until it hits the length limit', () => {
  const actual = jest.requireActual<typeof import('../../../../src/runtime/memory/memorySummarize')>(
    '../../../../src/runtime/memory/memorySummarize',
  );
  const FIRST_CAP = 800;

  /** A model that thinks for `thinkingTokens` before it writes; under a smaller cap it is cut off with no text. */
  function reasoningModel(options: { thinkingTokens: number; answer: string }): {
    llm: ILLM;
    caps: (number | null | undefined)[];
  } {
    const caps: (number | null | undefined)[] = [];
    const llm: ILLM = {
      create(): ReturnType<ILLM['create']> {
        throw new Error('streaming is not used by memory summarization');
      },
      createNonStream: async body => {
        caps.push(body.max_tokens);
        const cutOff = (body.max_tokens ?? 0) < options.thinkingTokens;
        return {
          output: { role: 'assistant', content: cutOff ? '' : options.answer },
          usage: {
            input_tokens: 0,
            output_tokens: cutOff ? (body.max_tokens ?? 0) : options.thinkingTokens,
            total_tokens: 0,
          },
          finish_reason: cutOff ? 'length' : 'stop',
        };
      },
    };
    return { llm, caps };
  }

  function useModel(llm: ILLM): void {
    mockSummarize.mockImplementation(params => actual.summarizeTurnContent({ ...params, resolveLlm: async () => llm }));
  }

  function storedLogs(dir: string): string[] {
    const memoryDir = path.join(dir, 'tenant-1', 'memory');
    return fs.existsSync(memoryDir)
      ? fs.readdirSync(memoryDir).map(name => fs.readFileSync(path.join(memoryDir, name), 'utf8'))
      : [];
  }

  async function retainTurn(dir: string): Promise<void> {
    const client = createMemoryClient({
      backend: 'markdown',
      markdownDir: dir,
      namespace: 'tenant-1',
      hindsight: undefined,
    });
    if (client === undefined) {
      throw new Error('expected a markdown memory client');
    }
    await submitRetainWithVerification({
      ...TURN,
      client,
      userText: 'Please remember that my houseplant is a cactus named Gerald.',
      assistantText: 'Noted: Gerald the cactus.',
      logger: makeLogger(),
      summarize: summarizeContext(),
    });
  }

  beforeEach(() => {
    mockSummarize.mockReset();
  });

  it('gets one more try with more room, and only the facts are stored', async () => {
    const { llm, caps } = reasoningModel({
      thinkingTokens: 2000,
      answer: '{"facts": ["The person has a cactus named Gerald."]}',
    });
    useModel(llm);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-reasoning-'));
    try {
      await retainTurn(dir);

      expect(caps).toHaveLength(2);
      expect(caps[0]).toBe(FIRST_CAP);
      expect(caps[1]).toBeGreaterThan(FIRST_CAP);
      const logs = storedLogs(dir);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('The person has a cactus named Gerald.');
      expect(logs[0]).not.toContain('User:');
      expect(logs[0]).not.toContain('Assistant:');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores nothing, not the chat text, when it is still cut off after the retry', async () => {
    const { llm, caps } = reasoningModel({ thinkingTokens: 1_000_000, answer: '{"facts": []}' });
    useModel(llm);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-reasoning-'));
    try {
      await retainTurn(dir);

      expect(caps).toHaveLength(2);
      expect(storedLogs(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores nothing for a turn with no durable facts', async () => {
    const { llm } = reasoningModel({ thinkingTokens: 10, answer: '{"facts": []}' });
    useModel(llm);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-reasoning-'));
    try {
      await retainTurn(dir);

      expect(storedLogs(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('turn outcome log at info', () => {
  const userText = 'Please remember that my houseplant is a cactus named Gerald.';
  const assistantText = 'Noted: Gerald the cactus.';

  function captureLogger(): { logger: winston.Logger; lines: string[] } {
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

  function infoEntries(lines: string[]): Record<string, unknown>[] {
    const entries: Record<string, unknown>[] = lines.map(line => JSON.parse(line));
    return entries.filter(entry => entry['level'] === 'info');
  }

  function submitFor(params: { client: MemoryClient; logger: winston.Logger; interactive: boolean }) {
    return {
      ...TURN,
      client: params.client,
      userText,
      assistantText,
      completedAt: '2026-10-22T12:00:00.000Z',
      logger: params.logger,
      outcomeLog: params.interactive ? { personaName: 'shared' } : undefined,
      summarize: summarizeContext(),
    };
  }

  beforeEach(() => {
    mockSummarize.mockReset();
  });

  it.each([
    ['model_timeout', { status: 'failed', reason: 'The operation timed out', fallback: 'model_timeout' }],
    ['model_failed', { status: 'failed', reason: 'provider down', fallback: 'model_failed' }],
    ['summary_unreadable', { status: 'failed', reason: 'summary-unreadable', fallback: 'summary_unreadable' }],
    ['summary_cut_short', { status: 'failed', reason: 'summary-cut-short', fallback: 'summary_cut_short' }],
    ['summary_too_long', { status: 'failed', reason: 'summary-too-long', fallback: 'summary_too_long' }],
  ] as const)('logs one info line with reason %s when the summary fails and nothing is saved', async (code, result) => {
    const { client, retain } = retainingClient();
    mockSummarize.mockResolvedValue(result);
    const { logger, lines } = captureLogger();

    await submitRetain(submitFor({ client, logger, interactive: true }));

    expect(retain).not.toHaveBeenCalled();
    const entries = infoEntries(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: 'Turn memory not saved: the summary failed',
      reason: code,
      sessionId: 's1',
      turnId: 't1',
      personaName: 'shared',
    });
    expect(lines.join('\n')).not.toContain('houseplant');
    expect(lines.join('\n')).not.toContain('Gerald');
  });

  it('logs why nothing was saved when there was nothing worth keeping', async () => {
    const { client, retain } = retainingClient();
    mockSummarize.mockResolvedValue({ status: 'nothing_to_keep' });
    const { logger, lines } = captureLogger();

    await submitRetain(submitFor({ client, logger, interactive: true }));

    expect(retain).not.toHaveBeenCalled();
    expect(infoEntries(lines)).toEqual([
      expect.objectContaining({
        message: 'Turn memory not saved: it held nothing worth keeping',
        reason: 'nothing_to_keep',
        personaName: 'shared',
      }),
    ]);
  });

  it('logs a reason code, and saves nothing, when the summarizer is skipped for a missing model or long input', async () => {
    const { client, retain } = retainingClient();
    const { logger, lines } = captureLogger();

    mockSummarize.mockResolvedValueOnce({ status: 'skipped', reason: 'no-model-configured' });
    await submitRetain(submitFor({ client, logger, interactive: true }));
    mockSummarize.mockResolvedValueOnce({ status: 'skipped', reason: 'input-too-long' });
    await submitRetain(submitFor({ client, logger, interactive: true }));

    expect(retain).not.toHaveBeenCalled();
    expect(infoEntries(lines).map(entry => entry['reason'])).toEqual(['no_summary_model', 'input_too_long']);
  });

  it('logs one info line when the Hindsight backend is given only an ability note', async () => {
    const { client, retain } = retainingClient();
    mockSummarize.mockResolvedValue({ status: 'summarized', facts: ["I can't read email right now."] });
    const { logger, lines } = captureLogger();

    await submitRetainWithVerification(submitFor({ client, logger, interactive: true }));

    expect(retain).not.toHaveBeenCalled();
    const entries = infoEntries(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: 'Turn memory not saved: it only described what the assistant could not do',
      reason: 'ability_notes_only',
      sessionId: 's1',
      turnId: 't1',
      personaName: 'shared',
    });
    expect(lines.join('\n')).not.toContain('houseplant');
  });

  it('logs one info line when the Markdown backend is given only an ability note', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retain-ability-'));
    try {
      const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
      mockSummarize.mockResolvedValue({ status: 'summarized', facts: ["I can't read email right now."] });
      const { logger, lines } = captureLogger();

      await submitRetainWithVerification(submitFor({ client, logger, interactive: true }));

      const entries = infoEntries(lines);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        message: 'Turn memory not saved: it only described what the assistant could not do',
        reason: 'ability_notes_only',
        personaName: 'shared',
      });
      expect(fs.existsSync(path.join(dir, 'tenant-1', 'memory'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a normal summarized turn silent at info', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });
    mockSummarize.mockResolvedValue({ status: 'summarized', facts: ['The person has a cactus named Gerald.'] });
    const { logger, lines } = captureLogger();

    await submitRetain(submitFor({ client, logger, interactive: true }));

    expect(infoEntries(lines)).toHaveLength(0);
  });

  it('logs nothing at info for a scheduled turn, even when the summary fails', async () => {
    const { client } = retainingClient();
    mockSummarize.mockResolvedValue({ status: 'failed', reason: 'provider down', fallback: 'model_failed' });
    const { logger, lines } = captureLogger();

    await submitRetain(submitFor({ client, logger, interactive: false }));

    expect(infoEntries(lines)).toHaveLength(0);
  });
});
