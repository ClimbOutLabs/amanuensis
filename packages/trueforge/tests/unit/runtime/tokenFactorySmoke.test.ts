import { formatSmokeLine, runTokenFactorySmoke } from '../../../src/runtime/tokenFactorySmoke';

const API_KEY = 'sk-nebius-very-secret';
const BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const CHEAPER_MODEL = 'openai/gpt-oss-120b';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function toolCallCompletion(name: string): Response {
  return json({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: '{"city":"Paris"}' } }],
        },
      },
    ],
  });
}

function textCompletion(): Response {
  return json({ choices: [{ message: { role: 'assistant', content: 'It is sunny in Paris.' } }] });
}

/** A scripted endpoint: records every request and answers by path. */
function endpoint(handlers: { models: () => Response; chat: (model: string) => Response }) {
  const requests: { url: string; authorization: string | null; body: unknown }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url, authorization, body });
    if (url.endsWith('/models')) {
      return Promise.resolve(handlers.models());
    }
    const model = typeof body === 'object' && body !== null && 'model' in body ? String(body.model) : '';
    return Promise.resolve(handlers.chat(model));
  };
  return { fetchImpl, requests };
}

const listing = (ids: string[]) => () => json({ data: ids.map(id => ({ id })) });

describe('runTokenFactorySmoke', () => {
  it('passes when every configured model is listed and answers with a get_weather tool call', async () => {
    const { fetchImpl, requests } = endpoint({
      models: listing([DEFAULT_MODEL, CHEAPER_MODEL, 'other/model']),
      chat: () => toolCallCompletion('get_weather'),
    });

    const checks = await runTokenFactorySmoke({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      models: [DEFAULT_MODEL, CHEAPER_MODEL],
      fetchImpl,
    });

    expect(checks.every(check => check.ok)).toBe(true);
    expect(checks.map(check => check.label)).toEqual([
      'GET /models',
      `model listed ${DEFAULT_MODEL}`,
      `tool call ${DEFAULT_MODEL}`,
      `model listed ${CHEAPER_MODEL}`,
      `tool call ${CHEAPER_MODEL}`,
    ]);
    expect(requests.map(request => request.url)).toEqual([
      `${BASE_URL}/models`,
      `${BASE_URL}/chat/completions`,
      `${BASE_URL}/chat/completions`,
    ]);
    expect(requests.every(request => request.authorization === `Bearer ${API_KEY}`)).toBe(true);
    expect(requests[1]?.body).toMatchObject({
      model: DEFAULT_MODEL,
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
  });

  it('fails when the configured model is not in the model list', async () => {
    const { fetchImpl } = endpoint({ models: listing(['other/model']), chat: () => toolCallCompletion('get_weather') });

    const checks = await runTokenFactorySmoke({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      models: [DEFAULT_MODEL],
      fetchImpl,
    });

    expect(checks.find(check => check.label === `model listed ${DEFAULT_MODEL}`)?.ok).toBe(false);
  });

  it('fails when the model answers in text instead of calling the tool', async () => {
    const { fetchImpl } = endpoint({ models: listing([DEFAULT_MODEL]), chat: textCompletion });

    const checks = await runTokenFactorySmoke({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      models: [DEFAULT_MODEL],
      fetchImpl,
    });

    const probe = checks.find(check => check.label === `tool call ${DEFAULT_MODEL}`);
    expect(probe).toEqual({
      ok: false,
      label: `tool call ${DEFAULT_MODEL}`,
      detail: 'the model answered without a tool_calls entry',
    });
  });

  it('fails when the model calls some other tool', async () => {
    const { fetchImpl } = endpoint({ models: listing([DEFAULT_MODEL]), chat: () => toolCallCompletion('get_time') });

    const checks = await runTokenFactorySmoke({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      models: [DEFAULT_MODEL],
      fetchImpl,
    });

    expect(checks.at(-1)?.detail).toBe('the model called get_time instead of get_weather');
  });

  it('reports a rejected key without ever printing it', async () => {
    const { fetchImpl } = endpoint({
      models: () => json({ error: { message: `Invalid key ${API_KEY}` } }, 401),
      chat: () => json({ error: { message: `Invalid key ${API_KEY}` } }, 401),
    });

    const checks = await runTokenFactorySmoke({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      models: [DEFAULT_MODEL],
      fetchImpl,
    });
    const printed = checks.map(formatSmokeLine).join('\n');

    expect(checks.every(check => !check.ok)).toBe(true);
    expect(printed).toContain('HTTP 401');
    expect(printed).not.toContain(API_KEY);
    expect(printed).toContain('[redacted]');
  });

  it('reports a network failure with its cause and still probes the tool call', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.reject(
        new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.tokenfactory.nebius.com') }),
      );

    const checks = await runTokenFactorySmoke({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      models: [DEFAULT_MODEL],
      fetchImpl,
    });

    expect(checks).toHaveLength(2);
    expect(checks[0]?.detail).toBe('fetch failed (getaddrinfo ENOTFOUND api.tokenfactory.nebius.com)');
    expect(checks.every(check => !check.ok)).toBe(true);
  });

  it('treats a body that is not a model list as a failure', async () => {
    const { fetchImpl } = endpoint({
      models: () => json({ models: [] }),
      chat: () => toolCallCompletion('get_weather'),
    });

    const checks = await runTokenFactorySmoke({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      models: [DEFAULT_MODEL],
      fetchImpl,
    });

    expect(checks[0]).toEqual({ ok: false, label: 'GET /models', detail: 'response has no model list' });
  });
});

describe('formatSmokeLine', () => {
  it('prints plain ok and fail lines', () => {
    expect(formatSmokeLine({ ok: true, label: 'GET /models', detail: '12 models' })).toBe(
      'ok   GET /models: 12 models',
    );
    expect(formatSmokeLine({ ok: false, label: 'GET /models', detail: 'HTTP 401' })).toBe('fail GET /models: HTTP 401');
  });
});
