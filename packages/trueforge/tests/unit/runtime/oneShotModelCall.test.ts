import type { Server } from 'node:http';
import winston from 'winston';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { askModelOnce, shortCallRequestFields } from '../../../src/runtime/oneShotModelCall';
import { TENANT_ID } from '../../../src/tenancy';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { startModelEndpointStub } from '../../fixtures/modelEndpointStub';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

describe('shortCallRequestFields', () => {
  it('turns thinking off and keeps the cap when the model can switch thinking off', () => {
    expect(
      shortCallRequestFields({ modelProperties: { reasoning_efforts: ['none', 'low', 'high'] }, maxTokens: 300 }),
    ).toEqual({ max_completion_tokens: 300, reasoning: { enable_thinking: false, reasoning_effort: 'none' } });
  });

  it('asks for the least thinking and adds room when thinking cannot be switched off', () => {
    expect(shortCallRequestFields({ modelProperties: { reasoning_efforts: ['low', 'high'] }, maxTokens: 300 })).toEqual(
      { max_completion_tokens: 1324, reasoning: { reasoning_effort: 'low' } },
    );
  });

  it('adds room and sends no reasoning field when the model lists no efforts', () => {
    expect(shortCallRequestFields({ modelProperties: {}, maxTokens: 300 })).toEqual({
      max_completion_tokens: 1324,
      reasoning: {},
    });
  });

  it('never asks for more than the model can write', () => {
    expect(shortCallRequestFields({ modelProperties: { max_output_tokens: 512 }, maxTokens: 300 })).toEqual({
      max_completion_tokens: 512,
      reasoning: {},
    });
  });
});

describe('askModelOnce on a provider that refuses the reasoning field', () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  it('asks again without the field, and does not send it to that model again', async () => {
    const stub = await startModelEndpointStub({
      content: 'yes',
      refuse: body =>
        'reasoning_effort' in body ? { status: 400, message: 'unsupported field: reasoning_effort' } : undefined,
    });
    servers.push(stub.server);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    const providerName = 'short-call-refuses';
    await modelProviderStore.upsertProvider({
      tenant_id: TENANT_ID,
      name: providerName,
      manifest: {
        type: 'custom',
        name: providerName,
        base_url: stub.baseUrl,
        models: [{ model_id: 'local-model', name: 'local-model', properties: { reasoning_efforts: ['low'] } }],
      },
    });
    const ask = () =>
      askModelOnce({
        tenantId: TENANT_ID,
        modelName: `${providerName}/local-model`,
        modelProviderStore,
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        usage: discardedModelUsage,
        logger: winston.createLogger({ silent: true }),
        role: 'summarization',
        messages: [{ role: 'user', content: 'Is this about the garden?' }],
        maxTokens: 300,
        timeoutMs: 5_000,
      });

    expect(await ask()).toBe('yes');
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]).toHaveProperty('reasoning_effort', 'low');
    expect(stub.requests[1]).not.toHaveProperty('reasoning_effort');

    expect(await ask()).toBe('yes');
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests[2]).not.toHaveProperty('reasoning_effort');
  });
});
