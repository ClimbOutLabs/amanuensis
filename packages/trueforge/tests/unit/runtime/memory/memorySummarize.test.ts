import type { ILLM } from '@truefoundry/trueforge-core/core';
import type { Server } from 'node:http';
import winston from 'winston';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { type IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteTokenFactoryUsageStore } from '../../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import { buildSummarizationMessages, summarizeTurnContent } from '../../../../src/runtime/memory/memorySummarize';
import { createTokenFactoryBudget } from '../../../../src/runtime/tokenFactoryBudget';
import { ensureEnvManagedTokenFactoryProvider } from '../../../../src/runtime/tokenFactoryProvider';
import { TENANT_ID } from '../../../../src/tenancy';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { startModelEndpointStub } from '../../../fixtures/modelEndpointStub';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

function makeLogger() {
  return winston.createLogger({ silent: true });
}

/**
 * A complete ILLM double for summarization tests: the summarizer only ever calls
 * `createNonStream`, and streaming refuses loudly so an unexpected call fails the test.
 */
function fakeSummarizer(content: string | { type: 'text'; text: string }[]): ILLM {
  const result: Awaited<ReturnType<ILLM['createNonStream']>> = {
    output: { role: 'assistant', content },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    finish_reason: 'stop',
  };
  return {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used by memory summarization');
    },
    createNonStream: async () => result,
  };
}

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

describe('buildSummarizationMessages', () => {
  it('includes the full exchange for the model to summarize', () => {
    const messages = buildSummarizationMessages({
      userText: 'My robot is named Bleep-Bloop.',
      assistantText: 'Got it, Bleep-Bloop.',
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('User: My robot is named Bleep-Bloop.');
    expect(messages[1]?.content).toContain('Assistant: Got it, Bleep-Bloop.');
  });

  it('instructs the model to capture durable facts, not small talk', () => {
    const messages = buildSummarizationMessages({ userText: 'hi', assistantText: 'hello' });
    const system = messages[0]?.content ?? '';
    expect(system).toContain('durable facts');
    expect(system).toContain('remember this');
  });
});

describe('summarizeTurnContent', () => {
  const base = {
    userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
    assistantText: 'Got it — Bleep-Bloop is your synthetic test robot.',
    tenantId: 'tenant-1',
    modelProviderStore: fakeModelProviderStore(),
    summarizationModelFqn: 'openai/gpt-4o',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
    logger: makeLogger(),
  };

  it('returns a summarized result on success', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => fakeSummarizer('- User has a synthetic test robot named Bleep-Bloop.'),
    });
    expect(result).toEqual({
      status: 'summarized',
      summary: '- User has a synthetic test robot named Bleep-Bloop.',
    });
  });

  it('returns skipped/empty-exchange when both sides are empty (nothing to summarize)', async () => {
    const result = await summarizeTurnContent({
      ...base,
      userText: '   ',
      assistantText: '',
      resolveLlm: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result).toEqual({ status: 'skipped', reason: 'empty-exchange' });
  });

  it('returns skipped/no-model-configured when no model FQN is available', async () => {
    const result = await summarizeTurnContent({
      ...base,
      summarizationModelFqn: undefined,
      resolveLlm: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result).toEqual({ status: 'skipped', reason: 'no-model-configured' });
  });

  it('returns failed and never throws when the LLM call fails', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => {
        throw new Error('provider down');
      },
    });
    expect(result).toEqual({ status: 'failed', reason: 'provider down' });
  });

  it('returns failed when the model returns an empty summary', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => fakeSummarizer('   '),
    });
    expect(result).toEqual({ status: 'failed', reason: 'empty-summary' });
  });

  it('returns failed for an overlong summary instead of truncating', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => fakeSummarizer('x'.repeat(5000)),
    });
    expect(result).toEqual({ status: 'failed', reason: 'summary-too-long' });
  });

  it('returns skipped/input-too-long instead of truncating an overlong turn', async () => {
    const result = await summarizeTurnContent({
      ...base,
      userText: 'x'.repeat(8001),
      resolveLlm: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result).toEqual({ status: 'skipped', reason: 'input-too-long' });
  });

  it('caps the generation with max_tokens so output cost is bounded', async () => {
    const llm = fakeSummarizer('- User has a synthetic test robot named Bleep-Bloop.');
    const createNonStream = jest.spyOn(llm, 'createNonStream');
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () => llm,
    });
    expect(result.status).toBe('summarized');
    expect(createNonStream).toHaveBeenCalledTimes(1);
    expect(createNonStream.mock.calls[0]?.[0]?.max_tokens).toBe(800);
  });

  it('flattens multi-part content responses', async () => {
    const result = await summarizeTurnContent({
      ...base,
      resolveLlm: async () =>
        fakeSummarizer([
          { type: 'text', text: 'Fact: ' },
          { type: 'text', text: 'Bleep-Bloop' },
        ]),
    });
    expect(result).toEqual({ status: 'summarized', summary: 'Fact: Bleep-Bloop' });
  });

  it('never holds more than the bounded number of concurrent LLM calls', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const blockingLlm = (): ILLM => ({
      create(): ReturnType<ILLM['create']> {
        throw new Error('streaming is not used by memory summarization');
      },
      createNonStream: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 25));
        inFlight -= 1;
        const result: Awaited<ReturnType<ILLM['createNonStream']>> = {
          output: { role: 'assistant', content: 'summary' },
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          finish_reason: 'stop',
        };
        return result;
      },
    });
    await Promise.all(
      Array.from({ length: 6 }, () => summarizeTurnContent({ ...base, resolveLlm: async () => blockingLlm() })),
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });
});

describe('summarizeTurnContent on Token Factory', () => {
  const NOW = new Date('2026-10-15T09:00:00.000Z');
  const TODAY = '2026-10-15';
  const CAP = 1000;
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  async function setup(providerType: 'tokenfactory' | 'custom') {
    const stub = await startModelEndpointStub({
      usage: { prompt_tokens: 150, completion_tokens: 25 },
      content: '- User has a synthetic test robot named Bleep-Bloop.',
    });
    servers.push(stub.server);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    if (providerType === 'tokenfactory') {
      await ensureEnvManagedTokenFactoryProvider({
        store: modelProviderStore,
        tenant_id: TENANT_ID,
        settings: {
          apiKey: 'sk-nebius',
          baseUrl: stub.baseUrl,
          model: 'nvidia/nemotron-3-super-120b-a12b',
          cheaperModel: undefined,
        },
        logger: makeLogger(),
      });
    } else {
      await modelProviderStore.upsertProvider({
        tenant_id: TENANT_ID,
        name: 'local-vllm',
        manifest: {
          type: 'custom',
          name: 'local-vllm',
          base_url: stub.baseUrl,
          models: [{ model_id: 'local-model', name: 'local-model', properties: {} }],
        },
      });
    }
    const usageStore = new SqliteTokenFactoryUsageStore(db);
    const tokenFactoryBudget = createTokenFactoryBudget({ store: usageStore, cap: CAP, now: () => NOW });
    const summarizationModelFqn =
      providerType === 'tokenfactory' ? 'tokenfactory/nemotron-3-super-120b-a12b' : 'local-vllm/local-model';
    const run = () =>
      summarizeTurnContent({
        userText: 'My robot is named Bleep-Bloop.',
        assistantText: 'Got it.',
        tenantId: TENANT_ID,
        modelProviderStore,
        summarizationModelFqn,
        tokenFactoryBudget,
        modelUsage: discardedModelUsage,
        logger: makeLogger(),
      });
    return { run, usageStore };
  }

  it('counts the tokens its call reports', async () => {
    const { run, usageStore } = await setup('tokenfactory');

    expect((await run()).status).toBe('summarized');

    expect((await usageStore.getUsage({ usage_date: TODAY }))?.used_tokens).toBe(175);
  });

  it('falls back to the verbatim transcript, without a call, once the cap is reached', async () => {
    const { run, usageStore } = await setup('tokenfactory');
    await usageStore.addUsage({
      usage_date: TODAY,
      model_id: 'nvidia/nemotron-3-super-120b-a12b',
      input_tokens: CAP,
      output_tokens: 0,
    });

    expect((await run()).status).toBe('failed');

    expect((await usageStore.getUsage({ usage_date: TODAY }))?.used_tokens).toBe(CAP);
  });

  it('counts nothing on another provider', async () => {
    const { run, usageStore } = await setup('custom');

    expect((await run()).status).toBe('summarized');

    expect(await usageStore.getUsage({ usage_date: TODAY })).toBeUndefined();
  });
});
