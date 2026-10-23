import {
  contextCompaction,
  type AgentThreadExecutionContext,
  type ILLM,
  type VercelAIProviderConfig,
} from '@truefoundry/trueforge-core/core';
import {
  clearModelContextLengthCache,
  reportedContextLength,
  resolveModelContextLength,
} from '../../../src/runtime/modelContextLength';

const SELF_HOSTED: VercelAIProviderConfig = {
  provider: { type: 'custom', name: 'home-server' },
  model: { id: 'example-org/example-model-32b', name: 'example-model' },
  name: 'home-server/example-model',
  baseUrl: 'http://192.0.2.10:8000/v1',
  apiKey: '',
  headers: {},
};

/** Whether compaction would call the summarizer on a chat of this many tokens, for a model of this context length. */
async function compactsAt({
  tokens,
  contextLength,
}: {
  tokens: number;
  contextLength: number | undefined;
}): Promise<boolean> {
  const createNonStream = jest.fn(() => Promise.reject(new Error('summarizer called')));
  const modelClient: ILLM = { create: jest.fn(), createNonStream };
  const processor = contextCompaction({
    logger: undefined,
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      modelParams: { max_tokens: 4096 },
      modelProperties: { contextLength },
    },
  }).preLLMProcessors?.[0];
  if (processor === undefined) {
    throw new Error('expected a compaction processor');
  }
  const execution: AgentThreadExecutionContext = {
    threadId: 'main',
    signal: undefined,
    currentContextUsage: { prompt_tokens: tokens, completion_tokens: 0 },
    context: [{ role: 'user', content: 'Plan the week.' }],
  };
  for await (const _event of processor.processPreLLM(execution)) {
    // Only whether the summarizer was asked matters here.
  }
  return createNonStream.mock.calls.length > 0;
}

function modelsResponse(body: unknown): typeof fetch {
  return jest.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })));
}

beforeEach(() => {
  clearModelContextLengthCache();
});

describe('reportedContextLength', () => {
  it('reads the limit each kind of server reports for the named model', () => {
    for (const field of ['max_model_len', 'max_context_length', 'context_length', 'context_window']) {
      const body = { data: [{ id: 'other' }, { id: 'example-org/example-model-32b', [field]: 131072 }] };
      expect(reportedContextLength({ body, modelId: 'example-org/example-model-32b' })).toBe(131072);
    }
  });

  it('reports nothing for another model, a missing limit, or a reply that is not a model list', () => {
    expect(reportedContextLength({ body: { data: [{ id: 'other', max_model_len: 8192 }] }, modelId: 'x' })).toBe(
      undefined,
    );
    expect(reportedContextLength({ body: { data: [{ id: 'x', max_model_len: null }] }, modelId: 'x' })).toBe(undefined);
    expect(reportedContextLength({ body: 'not json', modelId: 'x' })).toBe(undefined);
  });
});

describe('resolveModelContextLength', () => {
  it('uses the large limit a self-hosted server reports, so compaction does not start at 12,000 tokens', async () => {
    const fetchImpl = modelsResponse({
      object: 'list',
      data: [{ id: 'example-org/example-model-32b', object: 'model', max_model_len: 131072 }],
    });
    const contextLength = await resolveModelContextLength({
      providerConfig: SELF_HOSTED,
      configuredContextLength: 16384,
      fetchImpl,
    });
    expect(contextLength).toBe(131072);
    expect(fetchImpl).toHaveBeenCalledWith('http://192.0.2.10:8000/v1/models', expect.anything());

    expect(await compactsAt({ tokens: 12_000, contextLength })).toBe(false);
    // The small configured limit alone is what compacts a chat at about 12,000 tokens.
    expect(await compactsAt({ tokens: 12_000, contextLength: 16384 })).toBe(true);
  });

  it('keeps the configured limit when the server reports none, and asks the server only once', async () => {
    const fetchImpl = modelsResponse({ data: [{ id: 'example-org/example-model-32b' }] });
    const first = await resolveModelContextLength({
      providerConfig: SELF_HOSTED,
      configuredContextLength: 65536,
      fetchImpl,
    });
    const second = await resolveModelContextLength({
      providerConfig: SELF_HOSTED,
      configuredContextLength: 65536,
      fetchImpl,
    });
    expect(first).toBe(65536);
    expect(second).toBe(65536);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a server that cannot be reached as reporting nothing', async () => {
    const fetchImpl: typeof fetch = jest.fn(() => Promise.reject(new Error('connection refused')));
    await expect(
      resolveModelContextLength({ providerConfig: SELF_HOSTED, configuredContextLength: undefined, fetchImpl }),
    ).resolves.toBe(undefined);
  });

  it('does not ask a hosted provider, whose limit comes from its configuration', async () => {
    const fetchImpl = modelsResponse({ data: [] });
    const hosted: VercelAIProviderConfig = { ...SELF_HOSTED, provider: { type: 'openai', name: 'openai' } };
    await expect(
      resolveModelContextLength({ providerConfig: hosted, configuredContextLength: 400000, fetchImpl }),
    ).resolves.toBe(400000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
