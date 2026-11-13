/**
 * Auth-refusal wording and failure classification for provider calls: a refused key gets
 * Aman's own sentence naming the provider, and every failure lands in one reporting bucket.
 */
import { APICallError } from 'ai';
import {
  classifyProviderCallError,
  describeAuthRefusal,
  ModelStreamFault,
  VercelAILLM,
} from '../../../src/core/llm/VercelAILLM';
import { makeSilentLogger } from '../harnessMocks';

// Model HTTP rides the configured outbound fetch in production (util/outboundFetch);
// in these suites it delegates to the global fetch the tests stub.
jest.mock('../../../src/core/util/outboundFetch', () => {
  const actual = jest.requireActual<typeof import('../../../src/core/util/outboundFetch')>(
    '../../../src/core/util/outboundFetch',
  );
  return {
    ...actual,
    modelOutboundFetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      globalThis.fetch(input, init),
  };
});

const HEADLINE =
  'The model server refused the API key for my-llm. Check the key for this provider in Settings and try again.';

function apiError(input: { statusCode?: number; message: string }): APICallError {
  return new APICallError({
    message: input.message,
    url: 'https://llm.example.test/v1',
    requestBodyValues: {},
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
  });
}

describe('describeAuthRefusal', () => {
  it('names the provider and appends the server words for a 401', () => {
    expect(describeAuthRefusal(apiError({ statusCode: 401, message: 'invalid x-api-key' }), 'my-llm')).toBe(
      `${HEADLINE} The server said: invalid x-api-key`,
    );
  });

  it('covers a 403 carried in a data.code object, with no server text to append', () => {
    expect(describeAuthRefusal({ data: { code: 403 } }, 'my-llm')).toBe(HEADLINE);
  });

  it('gives the headline alone when the server sent no words', () => {
    expect(describeAuthRefusal(apiError({ statusCode: 401, message: '' }), 'my-llm')).toBe(HEADLINE);
  });

  it('finds the refusal down the cause chain', () => {
    const wrapped = new Error('stream failed', {
      cause: new Error('provider answer', { cause: apiError({ statusCode: 401, message: 'bad key' }) }),
    });
    expect(describeAuthRefusal(wrapped, 'my-llm')).toBe(`${HEADLINE} The server said: bad key`);
  });

  it.each([400, 429, 500])('stays silent for a non-auth status %i', statusCode => {
    expect(describeAuthRefusal(apiError({ statusCode, message: 'nope' }), 'my-llm')).toBeUndefined();
  });

  it('stays silent for an error with no status at all', () => {
    expect(describeAuthRefusal(new Error('socket closed'), 'my-llm')).toBeUndefined();
  });
});

describe('classifyProviderCallError', () => {
  it.each([401, 403])('reports a %i as a refused key', statusCode => {
    expect(classifyProviderCallError(apiError({ statusCode, message: 'no' }))).toBe('key_refused');
  });

  it.each([400, 429, 500])('reports a %i as a server error', statusCode => {
    expect(classifyProviderCallError(apiError({ statusCode, message: 'no' }))).toBe('server_error');
  });

  it('reports a call that never got a response as unreachable', () => {
    expect(classifyProviderCallError(apiError({ message: 'fetch failed' }))).toBe('unreachable');
  });

  it('reports a plain transport error as unreachable', () => {
    expect(classifyProviderCallError(new Error('connect ECONNREFUSED'))).toBe('unreachable');
  });

  it('sees through a stream fault to the transport failure that caused it', () => {
    const fault = new ModelStreamFault('stream ended', { cause: apiError({ message: 'fetch failed' }) });
    expect(classifyProviderCallError(fault)).toBe('unreachable');
  });

  it('reports a stream that broke after the server answered as a server error', () => {
    const fault = new ModelStreamFault('stream ended', { cause: new Error('closed early') });
    expect(classifyProviderCallError(fault)).toBe('server_error');
  });

  it('finds a refusal wrapped under the auth wording error a failed call throws', () => {
    const thrown = new Error(HEADLINE, {
      cause: new Error('Request failed (401): bad key', { cause: apiError({ statusCode: 401, message: 'bad key' }) }),
    });
    expect(classifyProviderCallError(thrown)).toBe('key_refused');
  });
});

describe('a model call the provider refuses', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function llmForStatus(status: number, serverMessage: string): VercelAILLM {
    jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: serverMessage } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    return new VercelAILLM({
      logger: makeSilentLogger(),
      streamTimeout: { firstChunkMs: 5_000, chunkMs: 5_000 },
      providerConfig: {
        provider: { type: 'custom', name: 'my-llm' },
        model: { id: 'llama-3', name: 'llama-3' },
        name: 'my-llm',
        baseUrl: 'https://llm.example.test/v1',
        apiKey: 'test-key',
        headers: {},
      },
    });
  }

  it('surfaces the auth sentence naming the provider when the key is refused', async () => {
    const llm = llmForStatus(401, 'bad key');
    await expect(llm.createNonStream({ messages: [{ role: 'user', content: 'Hello' }] })).rejects.toThrow(
      `${HEADLINE} The server said: bad key`,
    );
  });

  it('keeps the plain request-failed wording for a server error', async () => {
    const llm = llmForStatus(500, 'internal boom');
    await expect(llm.createNonStream({ messages: [{ role: 'user', content: 'Hello' }] })).rejects.toThrow(
      'Request failed (500): internal boom',
    );
  });
});
