import type { ModelRequestEvent, VercelAIProviderConfig } from '../../../src/core/llm/VercelAILLM';
import { buildLanguageModel } from '../../../src/core/llm/VercelAILLM';

const PRIVATE_PROMPT = 'PRIVATE-PROMPT-TEXT-DO-NOT-RECORD';

function config(overrides: Partial<VercelAIProviderConfig> = {}): VercelAIProviderConfig {
  return {
    provider: { type: 'custom', name: 'custom' },
    model: { id: 'stub-model', name: 'stub-model' },
    name: 'stub',
    apiKey: 'sk-secret-key-do-not-record',
    headers: {},
    baseUrl: 'https://models.example.test:8443/v1',
    ...overrides,
  };
}

const chatCompletion = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'stub-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
});

async function callModel(model: ReturnType<typeof buildLanguageModel>) {
  return model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: PRIVATE_PROMPT }] }] });
}

describe('buildLanguageModel request observer', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  let sentBodies: string[];

  beforeEach(() => {
    sentBodies = [];
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      sentBodies.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(
        new Response(chatCompletion, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('reports the host, model and body size of each request, and nothing else', async () => {
    const events: ModelRequestEvent[] = [];
    await callModel(buildLanguageModel(config(), event => events.push(event)));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      host: 'models.example.test:8443',
      model_id: 'stub-model',
      request_bytes: new TextEncoder().encode(sentBodies[0]).length,
    });
    expect(sentBodies[0]).toContain(PRIVATE_PROMPT);
    expect(JSON.stringify(events)).not.toContain(PRIVATE_PROMPT);
    expect(JSON.stringify(events)).not.toContain('sk-secret-key-do-not-record');
  });

  it('reports the real host when the provider uses its default endpoint', async () => {
    const events: ModelRequestEvent[] = [];
    const model = buildLanguageModel(
      config({ provider: { type: 'anthropic', name: 'anthropic' }, baseUrl: undefined }),
      event => events.push(event),
    );
    await callModel(model).catch(() => undefined);

    expect(events.map(event => event.host)).toEqual(['api.anthropic.com']);
  });

  it('still sends the request when the observer throws', async () => {
    const model = buildLanguageModel(config(), () => {
      throw new Error('recorder down');
    });
    await expect(callModel(model)).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('adds no wrapper when nothing observes', async () => {
    await callModel(buildLanguageModel(config()));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
