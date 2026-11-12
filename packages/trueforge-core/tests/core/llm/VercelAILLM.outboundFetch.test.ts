/**
 * Every provider's HTTP goes through the model outbound fetch, so each one gets its timeouts and
 * retries. A provider built without it would silently fall back to the global fetch.
 */
import { buildLanguageModel, VERCEL_AI_PROVIDER_NAMES } from '../../../src/core/llm/VercelAILLM';

const outboundCalls: string[] = [];

jest.mock('../../../src/core/util/outboundFetch', () => {
  const actual = jest.requireActual<typeof import('../../../src/core/util/outboundFetch')>(
    '../../../src/core/util/outboundFetch',
  );
  return {
    ...actual,
    modelOutboundFetch: async (input: string | URL | Request): Promise<Response> => {
      outboundCalls.push(input instanceof Request ? input.url : String(input));
      throw new Error('stopped at the model outbound fetch');
    },
  };
});

const BASE_URL = 'http://model.invalid/v1';

describe('model provider HTTP', () => {
  const globalFetch = jest.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    outboundCalls.length = 0;
    globalFetch.mockClear();
  });

  afterAll(() => {
    globalFetch.mockRestore();
  });

  it.each(VERCEL_AI_PROVIDER_NAMES)('sends %s requests through the model outbound fetch', async provider => {
    const model = buildLanguageModel({
      name: 'test',
      provider: { type: provider, name: provider },
      model: { id: 'test-model', name: 'test-model' },
      apiKey: 'sk-test',
      headers: {},
      baseUrl: BASE_URL,
    });

    await expect(
      model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }),
    ).rejects.toThrow();

    expect(outboundCalls).toHaveLength(1);
    expect(outboundCalls[0]?.startsWith(BASE_URL)).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
