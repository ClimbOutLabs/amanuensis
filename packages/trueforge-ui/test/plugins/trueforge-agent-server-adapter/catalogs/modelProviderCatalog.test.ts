import { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

import {
  createModelProviderCatalog,
  toHarnessModelEntry,
  toHarnessModelProvider,
  toUiCatalogModelProviderEntry,
  toUiModelEntry,
  toUiModelProvider,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/modelProviderCatalog.js';

/** The port declares delete as optional; these tests need the real implementation. */
function requireDelete(catalog: ReturnType<typeof createModelProviderCatalog>) {
  const remove = catalog.deleteModelProvider;
  if (remove === undefined) {
    throw new Error('deleteModelProvider is not implemented');
  }
  return remove;
}

describe('modelProviderCatalog mappers', () => {
  it('round-trips harness model entries through the UI shape', () => {
    const harness = {
      modelId: 'gpt-5.6-sol',
      name: 'gpt-5-6-sol',
      properties: {
        contextLength: 400000,
        maxOutputTokens: 32768,
        reasoningEfforts: ['low', 'medium', 'high'] as TrueForgeApi.ReasoningEffort[],
      },
    };

    assert.deepEqual(toUiModelEntry(harness), {
      id: 'gpt-5.6-sol',
      name: 'gpt-5-6-sol',
      properties: harness.properties,
    });
    assert.deepEqual(toHarnessModelEntry(toUiModelEntry(harness)), harness);
  });

  it('uses empty properties when the UI custom form omits them', () => {
    assert.deepEqual(toHarnessModelEntry({ id: 'llama3', name: 'llama3' }), {
      modelId: 'llama3',
      name: 'llama3',
      properties: {},
    });
  });

  it('names a well-known provider after its type and strips auth from the list card', () => {
    const harness = {
      type: 'openai' as const,
      auth: { apiKey: 'sk-secret' },
      models: [
        {
          modelId: 'gpt-5.6-sol',
          name: 'gpt-5-6-sol',
          properties: { contextLength: 400000, maxOutputTokens: 32768 },
        },
      ],
    };

    assert.deepEqual(toUiModelProvider({ name: 'openai', manifest: harness }), {
      id: 'openai',
      type: 'openai',
      name: 'openai',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'gpt-5-6-sol',
          properties: { contextLength: 400000, maxOutputTokens: 32768 },
        },
      ],
    });
  });

  // The stored name is the UI id, so getting this wrong points edits at the wrong row.
  it('keeps a custom provider under the name it was given', () => {
    assert.deepEqual(
      toUiModelProvider({
        name: 'local-llama',
        manifest: {
          type: 'custom' as const,
          name: 'local-llama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          auth: { apiKey: 'sk-local' },
          models: [{ modelId: 'llama3', name: 'llama3', properties: {} }],
        },
      }),
      {
        id: 'local-llama',
        type: 'custom',
        name: 'local-llama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [{ id: 'llama3', name: 'llama3', properties: {} }],
      },
    );
  });

  it('maps catalog presets and names them after their type', () => {
    assert.deepEqual(
      toUiCatalogModelProviderEntry({
        type: 'anthropic',
        models: [
          {
            modelId: 'claude-sonnet-4-6',
            name: 'claude-sonnet-4-6',
            properties: { contextLength: 200000, maxOutputTokens: 32768 },
          },
        ],
      }),
      {
        type: 'anthropic',
        name: 'anthropic',
        models: [
          {
            id: 'claude-sonnet-4-6',
            name: 'claude-sonnet-4-6',
            properties: { contextLength: 200000, maxOutputTokens: 32768 },
          },
        ],
      },
    );
  });

  it('builds discriminated harness upsert bodies from UI create/update requests', () => {
    assert.deepEqual(
      toHarnessModelProvider({
        type: 'openai',
        name: 'openai',
        apiKey: 'sk-test',
        models: [
          {
            id: 'gpt-5.6-sol',
            name: 'gpt-5-6-sol',
            properties: { contextLength: 400000, maxOutputTokens: 32768 },
          },
        ],
      }),
      // No name: a well-known provider is named after its type by the API.
      {
        type: 'openai',
        auth: { apiKey: 'sk-test' },
        models: [
          {
            modelId: 'gpt-5.6-sol',
            name: 'gpt-5-6-sol',
            properties: { contextLength: 400000, maxOutputTokens: 32768 },
          },
        ],
      },
    );

    assert.deepEqual(
      toHarnessModelProvider({
        type: 'custom',
        name: 'local-llama',
        apiKey: 'sk-local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [{ id: 'llama3', name: 'llama3' }],
      }),
      {
        type: 'custom',
        name: 'local-llama',
        auth: { apiKey: 'sk-local' },
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          {
            modelId: 'llama3',
            name: 'llama3',
            properties: {},
          },
        ],
      },
    );

    assert.deepEqual(
      toHarnessModelProvider({
        type: 'custom',
        name: 'local-llama',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [{ id: 'llama3', name: 'llama3' }],
      }),
      {
        type: 'custom',
        name: 'local-llama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          {
            modelId: 'llama3',
            name: 'llama3',
            properties: {},
          },
        ],
      },
    );
  });

  it('rejects custom providers without a base URL', () => {
    assert.throws(
      () =>
        toHarnessModelProvider({
          type: 'custom',
          name: 'broken',
          apiKey: 'sk',
          models: [{ id: 'm', name: 'm' }],
        }),
      /base URL/i,
    );
  });

  it('carries an explicit streamTimeout override onto the harness manifest and back', () => {
    const created = toHarnessModelProvider({
      type: 'custom',
      name: 'local-llama',
      apiKey: 'sk-local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [{ id: 'llama3', name: 'llama3' }],
      streamTimeout: { firstChunkMs: 120_000, chunkMs: 90_000 },
    });
    assert.deepEqual(created.streamTimeout, { firstChunkMs: 120_000, chunkMs: 90_000 });

    // `created` is already a real `TrueForgeApi.ModelProviderManifest` — `streamTimeout` is a
    // native field on the generated type, not a local shim, so no cast is needed here.
    assert.deepEqual(
      toUiModelProvider({
        name: 'local-llama',
        manifest: created,
      }).streamTimeout,
      { firstChunkMs: 120_000, chunkMs: 90_000 },
    );
  });

  it('omits streamTimeout from the harness manifest when unset or empty', () => {
    const withoutOverride = toHarnessModelProvider({
      type: 'custom',
      name: 'local-llama',
      apiKey: 'sk-local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [{ id: 'llama3', name: 'llama3' }],
    });
    assert.equal('streamTimeout' in withoutOverride, false);

    const withEmptyOverride = toHarnessModelProvider({
      type: 'custom',
      name: 'local-llama',
      apiKey: 'sk-local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [{ id: 'llama3', name: 'llama3' }],
      streamTimeout: {},
    });
    assert.equal('streamTimeout' in withEmptyOverride, false);
  });

  // Catalog presets are copied straight into this form, so a type the API accepts but this mapper
  // does not is a preset the user cannot save.
  it('builds a body for every provider type the API accepts', () => {
    const types = [...Object.values(TrueForgeApi.CatalogWellKnownModelProviderType), 'custom'];
    for (const type of types) {
      const body = toHarnessModelProvider({
        type,
        name: type,
        apiKey: 'sk',
        baseUrl: 'https://example.com/v1',
        models: [{ id: 'm', name: 'm' }],
      });
      assert.equal(body.type, type);
    }
  });
});

describe('modelProviderCatalog delete', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function catalogWithFetch(fetchImpl: typeof fetch) {
    const client = new TrueForge({ baseUrl: 'http://harness.test', maxRetries: 0, fetch: fetchImpl });
    return createModelProviderCatalog(client);
  }

  it('issues a DELETE against the server row and resolves once it succeeds', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const catalog = catalogWithFetch(async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await requireDelete(catalog)({ id: 'anthropic' });

    assert.deepEqual(calls, [
      { url: 'http://harness.test/api/v1/settings/model-providers/anthropic', method: 'DELETE' },
    ]);
  });

  // A delete that never gets an answer must still give up well inside the SDK's 60s default, so
  // a slow/unreachable Harness server cannot hold the Settings UI in a "deleting…" state long
  // enough to read as a frozen tab.
  it('aborts the request well before the SDK default 60s timeout when the server never answers', async () => {
    let observedSignal: AbortSignal | null | undefined;
    const catalog = catalogWithFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal;
          observedSignal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    vi.useFakeTimers();
    const pending = requireDelete(catalog)({ id: 'anthropic' });
    // Attach the rejection expectation immediately: `pending` rejects once the fake clock is
    // advanced below, and leaving it unhandled in between trips Node's unhandled-rejection check.
    const rejection = assert.rejects(pending);

    // Well under the SDK's 60s default, but past a deliberately short delete-specific timeout.
    await vi.advanceTimersByTimeAsync(20_000);

    assert.equal(observedSignal?.aborted, true);
    await rejection;
  });

  // The delete-specific timeout bounds a single attempt; it means nothing if the SDK's default
  // retries (up to two more, with delays as long as 60s between them) still run underneath it.
  it('does not retry a retryable response, so the deadline stays a real bound rather than a per-attempt one', async () => {
    // No client-level maxRetries override here (unlike catalogWithFetch above): this exercises
    // the SDK's actual default of two retries, so the assertion below only passes if
    // deleteModelProvider's own request-level `maxRetries: 0` is what suppresses them.
    const calls: { url: string; method: string | undefined }[] = [];
    const client = new TrueForge({
      baseUrl: 'http://harness.test',
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const catalog = createModelProviderCatalog(client);

    await assert.rejects(requireDelete(catalog)({ id: 'anthropic' }));

    assert.equal(calls.length, 1);
  });
});
