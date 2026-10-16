import type { Server } from 'node:http';
import { createLogger } from 'winston';

import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteTokenFactoryUsageStore } from '../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import { createKnowledgeRelevanceJudge } from '../../../src/personaKnowledge/knowledgeRelevanceJudge';
import { createTokenFactoryBudget, TokenFactoryDailyCapError } from '../../../src/runtime/tokenFactoryBudget';
import { ensureEnvManagedTokenFactoryProvider } from '../../../src/runtime/tokenFactoryProvider';
import { TENANT_ID } from '../../../src/tenancy';
import { startModelEndpointStub } from '../../fixtures/modelEndpointStub';

const NOW = new Date('2026-10-15T09:00:00.000Z');
const TODAY = '2026-10-15';
const CAP = 1000;
const logger = createLogger({ silent: true });
const candidates = [
  { text: 'The solo project sold in 2021.', title: 'Notes', sourceLabel: 'notes.md', sourceUrl: null, similarity: 0.9 },
];

describe('the knowledge relevance judge on Token Factory', () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  async function setup(options: { providerType: 'tokenfactory' | 'custom' }) {
    const stub = await startModelEndpointStub({
      usage: { prompt_tokens: 200, completion_tokens: 20 },
      content: '{"helpful":[1]}',
    });
    servers.push(stub.server);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    if (options.providerType === 'tokenfactory') {
      await ensureEnvManagedTokenFactoryProvider({
        store: modelProviderStore,
        tenant_id: TENANT_ID,
        settings: {
          apiKey: 'sk-nebius',
          baseUrl: stub.baseUrl,
          model: 'nvidia/nemotron-3-super-120b-a12b',
          cheaperModel: undefined,
        },
        logger,
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
    const budget = createTokenFactoryBudget({ store: usageStore, cap: CAP, now: () => NOW });
    const modelName =
      options.providerType === 'tokenfactory' ? 'tokenfactory/nemotron-3-super-120b-a12b' : 'local-vllm/local-model';
    const judge = createKnowledgeRelevanceJudge({
      tenantId: TENANT_ID,
      modelName,
      modelProviderStore,
      tokenFactoryBudget: budget,
      logger,
    });
    return { judge, usageStore };
  }

  it('counts the tokens its call reports', async () => {
    const { judge, usageStore } = await setup({ providerType: 'tokenfactory' });

    await expect(judge('When did the solo project sell?', candidates)).resolves.toEqual([0]);

    expect((await usageStore.getUsage({ usage_date: TODAY }))?.used_tokens).toBe(220);
  });

  it('is refused once the cap is reached, which the caller treats as a judge outage', async () => {
    const { judge, usageStore } = await setup({ providerType: 'tokenfactory' });
    await usageStore.addUsage({ usage_date: TODAY, tokens: CAP });

    await expect(judge('When did the solo project sell?', candidates)).rejects.toBeInstanceOf(
      TokenFactoryDailyCapError,
    );
    expect((await usageStore.getUsage({ usage_date: TODAY }))?.used_tokens).toBe(CAP);
  });

  it('counts nothing for a persona on another provider', async () => {
    const { judge, usageStore } = await setup({ providerType: 'custom' });
    await usageStore.addUsage({ usage_date: TODAY, tokens: CAP });

    await expect(judge('When did the solo project sell?', candidates)).resolves.toEqual([0]);

    expect((await usageStore.getUsage({ usage_date: TODAY }))?.used_tokens).toBe(CAP);
  });
});
