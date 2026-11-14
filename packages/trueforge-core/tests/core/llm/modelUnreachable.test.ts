import { APICallError } from 'ai';
import {
  ModelUnreachableError,
  modelUnreachableErrorOf,
  modelUnreachableMessage,
  neverStartedModelUrl,
} from '../../../src/core/llm/modelUnreachable';

const MODEL_URL = 'https://spark.example.ts.net/v1/chat/completions';

/** The AI SDK's error for a fetch that never got an answer, the way handleFetchError builds it. */
function connectFailure({ code, url = MODEL_URL }: { code: string; url?: string }): APICallError {
  const cause = Object.assign(new Error(`connect ${code} 100.101.102.103:443`), { code });
  return new APICallError({
    message: `Cannot connect to API: ${cause.message}`,
    url,
    requestBodyValues: {},
    cause,
    isRetryable: true,
  });
}

describe('neverStartedModelUrl', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET'])(
    'names the model URL when the connection failed with %s before any answer',
    code => {
      expect(neverStartedModelUrl(connectFailure({ code }))).toBe(MODEL_URL);
    },
  );

  it('finds the socket code deeper in the cause chain', () => {
    const socket = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const fetchFailed = new TypeError('fetch failed', { cause: socket });
    const error = new APICallError({
      message: 'Cannot connect to API: fetch failed',
      url: MODEL_URL,
      requestBodyValues: {},
      cause: fetchFailed,
    });
    expect(neverStartedModelUrl(error)).toBe(MODEL_URL);
  });

  it('is undefined for a provider that answered with a status', () => {
    const error = new APICallError({
      message: 'Unauthorized',
      url: MODEL_URL,
      requestBodyValues: {},
      statusCode: 401,
      cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
    });
    expect(neverStartedModelUrl(error)).toBeUndefined();
  });

  it('is undefined for a reply that broke off while it was being read', () => {
    // A body read failure is not the SDK's call error: the response had already begun.
    expect(neverStartedModelUrl(Object.assign(new Error('terminated'), { code: 'UND_ERR_SOCKET' }))).toBeUndefined();
  });

  it('is undefined for a call error with no socket failure behind it', () => {
    const error = new APICallError({ message: 'Invalid JSON response', url: MODEL_URL, requestBodyValues: {} });
    expect(neverStartedModelUrl(error)).toBeUndefined();
  });
});

describe('modelUnreachableMessage', () => {
  const forbidden = /broke off|—|;/;

  it('says a model elsewhere could not be reached, and names its host', () => {
    const message = modelUnreachableMessage({
      url: 'https://models.example.com/v1/chat/completions',
      place: 'elsewhere',
    });
    expect(message).toBe(
      'Aman could not connect to the model at models.example.com, so no reply was started. ' +
        'Check that the model server is running and can be reached from this computer, then send your message again.',
    );
    expect(message).not.toMatch(forbidden);
  });

  it('says nothing answered at the local link’s port, and to start the model server', () => {
    const message = modelUnreachableMessage({
      url: 'http://aman-local-model:30031/v1/chat/completions',
      place: 'local_link',
    });
    expect(message).toContain('Nothing answered at port 30031 on this computer.');
    expect(message).toContain('Start the model server on this computer, then send your message again.');
    expect(message).not.toMatch(forbidden);
  });
});

describe('modelUnreachableErrorOf', () => {
  it('asks the host where the model is, by host name', () => {
    const asked: string[] = [];
    const error = modelUnreachableErrorOf({
      raw: connectFailure({ code: 'ECONNREFUSED' }),
      placeOfModelHost: hostname => {
        asked.push(hostname);
        return 'local_link';
      },
    });
    expect(asked).toEqual(['spark.example.ts.net']);
    expect(error).toBeInstanceOf(ModelUnreachableError);
    expect(error?.place).toBe('local_link');
    expect(error?.url).toBe(MODEL_URL);
  });

  it('treats the model as elsewhere when the host has no say', () => {
    expect(
      modelUnreachableErrorOf({ raw: connectFailure({ code: 'ECONNREFUSED' }), placeOfModelHost: undefined })?.place,
    ).toBe('elsewhere');
  });

  it('is undefined for anything that is not a connection that never started', () => {
    expect(
      modelUnreachableErrorOf({ raw: new Error('stream broke'), placeOfModelHost: () => 'local_link' }),
    ).toBeUndefined();
  });
});
