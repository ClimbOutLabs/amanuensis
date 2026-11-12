import { createLogger } from 'winston';
import type { IModelProviderStore, ModelProviderRecord } from '../../../src/db/modelProviderStore';
import { createModelProviderChecker } from '../../../src/runtime/modelProviderCheck';
import type { ModelProviderManifest } from '../../../src/schemas/modelProvider';

const mockCreateNonStream = jest.fn();
const mockGetModelDetails = jest.fn();
const mockLlmSignals: (AbortSignal | undefined)[] = [];

jest.mock('@truefoundry/trueforge-core/core', () => {
  const actual = jest.requireActual<typeof import('@truefoundry/trueforge-core/core')>(
    '@truefoundry/trueforge-core/core',
  );
  return {
    ...actual,
    VercelAILLM: jest.fn().mockImplementation((options: { signal?: AbortSignal }) => {
      mockLlmSignals.push(options.signal);
      return {
        createNonStream: (...args: unknown[]) => mockCreateNonStream(...args),
      };
    }),
  };
});

jest.mock('../../../src/runtime/sessionResources', () => ({
  getModelDetails: (...args: unknown[]) => mockGetModelDetails(...args),
}));

// A short limit for this suite only, so the timed-out test does not wait out the real one.
jest.mock('../../../src/help/healthProbes', () => ({ MODEL_PROBE_TIMEOUT_MS: 25 }));

const silentLogger = createLogger({ silent: true });

const MANIFEST = {
  type: 'custom',
  name: 'my-llm',
  base_url: 'https://llm.example.test/v1',
  auth: { api_key: 'sk-test' },
  models: [{ model_id: 'llama-3', name: 'llama-3', properties: { context_length: 8000 } }],
} satisfies ModelProviderManifest;

const RECORD: ModelProviderRecord = {
  tenant_id: 'default',
  name: 'my-llm',
  manifest: MANIFEST,
  last_check: null,
  created_at: '2026-11-09T00:00:00.000Z',
  updated_at: '2026-11-09T00:00:00.000Z',
};

const checkSavedProvider = createModelProviderChecker({ logger: silentLogger });

beforeEach(() => {
  mockCreateNonStream.mockReset();
  mockGetModelDetails.mockReset();
  mockLlmSignals.length = 0;
  mockGetModelDetails.mockResolvedValue({
    providerConfig: { provider: { type: 'custom', name: 'my-llm' }, model: { id: 'llama-3', name: 'llama-3' } },
    streamTimeout: { firstChunkMs: 1_000, chunkMs: 1_000, progressTimeoutMs: 1_000 },
  });
});

describe('createModelProviderChecker', () => {
  it('reports answered when the test call goes through, using the first model', async () => {
    mockCreateNonStream.mockResolvedValue({ output: { content: 'ok' } });

    const check = await checkSavedProvider({ tenant_id: 'default', store: fakeStore(), record: RECORD });

    expect(check.kind).toBe('answered');
    expect(check.message).toBe('The model server answered the test call.');
    expect(check.checked_at).toEqual(expect.any(String));
    expect(mockGetModelDetails).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'default', name: 'my-llm/llama-3' }),
    );
  });

  it('reports a refused key when the call fails with a 401 in its cause chain', async () => {
    mockCreateNonStream.mockRejectedValue(
      new Error('The model server refused the API key for my-llm.', { cause: { data: { code: 401 } } }),
    );

    const check = await checkSavedProvider({ tenant_id: 'default', store: fakeStore(), record: RECORD });

    expect(check.kind).toBe('key_refused');
    expect(check.message).toBe('The model server refused the API key. Check the key for this provider and save again.');
  });

  it('reports unreachable when no answer comes back', async () => {
    mockCreateNonStream.mockRejectedValue(new Error('fetch failed'));

    const check = await checkSavedProvider({ tenant_id: 'default', store: fakeStore(), record: RECORD });

    expect(check.kind).toBe('unreachable');
    expect(check.message).toBe(
      'The model server did not answer. Check the server is running and the address is right, then save again.',
    );
  });

  it('reports timed out when the test call is still unanswered at the time limit', async () => {
    // A slow local server: the call ends only when the probe's own time limit cuts it off.
    mockCreateNonStream.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          const signal = mockLlmSignals[0];
          if (signal === undefined) {
            reject(new Error('the checker handed no signal to the test call'));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    const check = await checkSavedProvider({ tenant_id: 'default', store: fakeStore(), record: RECORD });

    expect(check.kind).toBe('timed_out');
    expect(check.message).toBe(
      'The model server took too long to answer. It may still be starting up, or busy loading the model. ' +
        'Wait a moment, then save again.',
    );
    expect(check.message).not.toBe(
      'The model server did not answer. Check the server is running and the address is right, then save again.',
    );
  });

  it('reports a server error when the provider answers with a 500', async () => {
    mockCreateNonStream.mockRejectedValue(new Error('Request failed (500): boom', { cause: { data: { code: 500 } } }));

    const check = await checkSavedProvider({ tenant_id: 'default', store: fakeStore(), record: RECORD });

    expect(check.kind).toBe('server_error');
    expect(check.message).toBe('The model server answered with an error. Check the provider settings and save again.');
  });
});

/** The checker only hands the store to getModelDetails, which is mocked here, so no store behaviour is needed. */
function fakeStore(): IModelProviderStore {
  return {
    managedElsewhere: false,
    listProviders: () => Promise.resolve([]),
    getProvider: () => Promise.resolve(undefined),
    getProviderForUpdate: () => Promise.resolve(undefined),
    createProvider: () => Promise.reject(new Error('not used')),
    upsertProvider: () => Promise.reject(new Error('not used')),
    recordProviderCheck: () => Promise.resolve(undefined),
    deleteProvider: () => Promise.resolve(false),
    listModels: () => Promise.resolve([]),
  };
}
