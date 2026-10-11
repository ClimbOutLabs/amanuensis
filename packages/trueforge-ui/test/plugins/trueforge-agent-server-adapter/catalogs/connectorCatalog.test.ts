import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

import {
  createConnectorCatalog,
  memoryProviderWriteRequestOptions,
  toHarnessAuth,
  toHarnessManifest,
  toUiAuthPublic,
  toUiCatalogEntry,
  toUiConnector,
  toUiConnectorFromReadEntry,
  toUiTool,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/connectorCatalog.js';

describe('connectorCatalog mappers', () => {
  it('uses one bounded non-retrying request for memory-provider writes', () => {
    assert.deepEqual(memoryProviderWriteRequestOptions(true), { timeoutInSeconds: 125, maxRetries: 0 });
    assert.equal(memoryProviderWriteRequestOptions(false), undefined);
    assert.equal(memoryProviderWriteRequestOptions(undefined), undefined);
  });

  it('carries memory tuning from the UI request to the manifest and back to the UI connector', () => {
    const memorySettings = { recallTimeoutMs: 6_000, reflectEnabled: false, reflectBudget: 'low' as const };
    const manifest = toHarnessManifest({
      name: 'hindsight',
      url: 'https://memory.example/mcp/default/',
      auth: { type: 'none' },
      memoryProvider: true,
      memorySettings,
    });
    assert.deepEqual(Reflect.get(manifest, 'memorySettings'), memorySettings);
    const connector = toUiConnector({ name: 'hindsight', manifest, authStatus: { status: 'not_required' } });
    assert.deepEqual(connector.memorySettings, memorySettings);
    assert.equal(
      'memorySettings' in toHarnessManifest({ name: 'plain', url: 'https://mcp.example/', auth: { type: 'none' } }),
      false,
    );
  });

  it('maps harness auth to UI public auth without secrets', () => {
    assert.deepEqual(toUiAuthPublic(undefined), { type: 'none' });
    assert.deepEqual(toUiAuthPublic({ type: 'dcr' }), { type: 'dcr' });
    assert.deepEqual(toUiAuthPublic({ type: 'header', headers: { Authorization: 'Bearer secret' } }), {
      type: 'header',
      headerName: 'Authorization',
    });
  });

  it('maps UI write auth onto harness dcr/header/omit', () => {
    assert.equal(toHarnessAuth({ type: 'none' }), undefined);
    assert.deepEqual(toHarnessAuth({ type: 'dcr' }), { type: 'dcr' });
    assert.deepEqual(toHarnessAuth({ type: 'header', apiKey: 'sk-test' }), {
      type: 'header',
      headers: { Authorization: 'Bearer sk-test' },
    });
    assert.deepEqual(toHarnessAuth({ type: 'header', apiKey: 'tok', headerName: 'X-Api-Key' }), {
      type: 'header',
      headers: { 'X-Api-Key': 'tok' },
    });
  });

  it('leaves an already-schemed Authorization value untouched', () => {
    assert.deepEqual(toHarnessAuth({ type: 'header', apiKey: 'Bearer x' }), {
      type: 'header',
      headers: { Authorization: 'Bearer x' },
    });
    assert.deepEqual(toHarnessAuth({ type: 'header', apiKey: 'Basic abc' }), {
      type: 'header',
      headers: { Authorization: 'Basic abc' },
    });
  });

  it('leaves custom header names unprefixed', () => {
    assert.deepEqual(toHarnessAuth({ type: 'header', apiKey: 'tok', headerName: 'X-Api-Key' }), {
      type: 'header',
      headers: { 'X-Api-Key': 'tok' },
    });
  });

  it('rejects header auth without a key', () => {
    assert.throws(() => toHarnessAuth({ type: 'header' }), /API key is required/i);
  });

  it('maps catalog presets using name as id', () => {
    assert.deepEqual(
      toUiCatalogEntry({
        type: 'remote',
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        description: 'Linear MCP server.',
        auth: { type: 'dcr' },
      }),
      {
        id: 'linear',
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        description: 'Linear MCP server.',
        auth: { type: 'dcr' },
      },
    );
  });

  it('maps configured servers without embedding tools', () => {
    assert.deepEqual(
      toUiConnector({
        name: 'deepwiki',
        manifest: {
          type: 'remote',
          name: 'deepwiki',
          url: 'https://mcp.deepwiki.com/mcp',
          description: 'DeepWiki MCP server.',
        },
        authStatus: { status: 'not_required' },
      }),
      {
        id: 'deepwiki',
        name: 'deepwiki',
        description: 'DeepWiki MCP server.',
        url: 'https://mcp.deepwiki.com/mcp',
        auth: { type: 'none' },
        requiresAuth: false,
        authenticated: true,
      },
    );
  });

  it('maps auth_required vs authenticated for oauth connectors', () => {
    const pending = toUiConnector({
      name: 'linear',
      manifest: {
        type: 'remote',
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        description: 'Linear MCP server.',
        auth: { type: 'dcr' },
      },
      authStatus: { status: 'auth_required' },
    });
    assert.equal(pending.authenticated, false);
    assert.equal(pending.requiresAuth, true);

    const connected = toUiConnector({
      name: 'linear',
      manifest: {
        type: 'remote',
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        description: 'Linear MCP server.',
        auth: { type: 'dcr' },
      },
      authStatus: { status: 'authenticated' },
    });
    assert.equal(connected.authenticated, true);
    assert.equal(connected.requiresAuth, false);
  });

  it('maps memoryProvider from the manifest onto the UI connector', () => {
    // `TrueForgeApi.McpServerManifest` may not declare `memoryProvider` yet (it lands
    // separately on the server side); widen the fixture's type locally rather than the SDK.
    const manifestWithMemory: TrueForgeApi.McpServerManifest & { memoryProvider: boolean } = {
      type: 'remote',
      name: 'hindsight',
      url: 'https://memory.example/mcp/default/',
      description: 'Hindsight memory MCP server.',
      memoryProvider: true,
    };
    assert.deepEqual(
      toUiConnector({
        name: 'hindsight',
        manifest: manifestWithMemory,
        authStatus: { status: 'not_required' },
      }),
      {
        id: 'hindsight',
        name: 'hindsight',
        description: 'Hindsight memory MCP server.',
        url: 'https://memory.example/mcp/default/',
        auth: { type: 'none' },
        requiresAuth: false,
        authenticated: true,
        memoryProvider: true,
      },
    );
  });

  it('maps the search provider role from the manifest, whichever spelling the SDK delivers', () => {
    const base = {
      type: 'remote' as const,
      name: 'finder',
      url: 'https://finder.example/mcp',
      description: 'Finder.',
    };
    // The generated SDK passes a key it does not declare through unchanged, so the wire name arrives as is.
    const fromWire: TrueForgeApi.McpServerManifest & { search_provider: boolean } = { ...base, search_provider: true };
    // Once the SDK declares the field it camel-cases it.
    const fromSdk: TrueForgeApi.McpServerManifest & { searchProvider: boolean } = { ...base, searchProvider: true };
    for (const manifest of [fromWire, fromSdk]) {
      assert.equal(
        toUiConnector({ name: 'finder', manifest, authStatus: { status: 'not_required' } }).searchProvider,
        true,
      );
    }
    assert.equal(
      'searchProvider' in toUiConnector({ name: 'finder', manifest: base, authStatus: { status: 'not_required' } }),
      false,
    );
  });

  it('sends the search provider role under its wire name and omits it when unset', () => {
    const request = { name: 'finder', url: 'https://finder.example/mcp', auth: { type: 'none' as const } };
    assert.deepEqual(toHarnessManifest({ ...request, searchProvider: true }), {
      type: 'remote',
      name: 'finder',
      url: 'https://finder.example/mcp',
      description: 'finder MCP server',
      search_provider: true,
    });
    assert.equal('search_provider' in toHarnessManifest(request), false);
  });

  it('carries a catalog preset’s offer to be the search provider', () => {
    const preset: TrueForgeApi.CatalogMcpServer & { search_provider: boolean } = {
      type: 'remote',
      name: 'parallel-web',
      url: 'https://search.parallel.ai/mcp',
      description: 'Search the web.',
      search_provider: true,
    };
    assert.equal(toUiCatalogEntry(preset).searchProvider, true);
  });

  it('omits memoryProvider when the manifest does not set it', () => {
    assert.deepEqual(
      toUiConnector({
        name: 'deepwiki',
        manifest: {
          type: 'remote',
          name: 'deepwiki',
          url: 'https://mcp.deepwiki.com/mcp',
          description: 'DeepWiki MCP server.',
        },
        authStatus: { status: 'not_required' },
      }),
      {
        id: 'deepwiki',
        name: 'deepwiki',
        description: 'DeepWiki MCP server.',
        url: 'https://mcp.deepwiki.com/mcp',
        auth: { type: 'none' },
        requiresAuth: false,
        authenticated: true,
      },
    );
  });

  it('maps chat read entries from per-user auth_status', () => {
    assert.deepEqual(
      toUiConnectorFromReadEntry({
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        auth: { type: 'dcr' },
        authStatus: { status: 'auth_required' },
      }),
      {
        id: 'linear',
        name: 'linear',
        description: 'https://mcp.linear.app/mcp',
        url: 'https://mcp.linear.app/mcp',
        auth: { type: 'dcr' },
        requiresAuth: true,
        authenticated: false,
      },
    );
  });

  it('maps tool rows with description for getToolsByConnectorId', () => {
    assert.deepEqual(toUiTool({ name: 'search', description: 'Find docs' }), {
      id: 'search',
      name: 'search',
      description: 'Find docs',
    });
    assert.deepEqual(toUiTool({ name: 'search' }), {
      id: 'search',
      name: 'search',
      description: '',
    });
    assert.deepEqual(toUiTool({}), { id: 'tool', name: 'tool', description: '' });
  });

  it('forwards boolean readOnlyHint and destructiveHint annotations', () => {
    assert.deepEqual(
      toUiTool({
        name: 'list',
        description: 'List items',
        annotations: { readOnlyHint: true, destructiveHint: false, title: 'List' },
      }),
      {
        id: 'list',
        name: 'list',
        description: 'List items',
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    );
    assert.deepEqual(
      toUiTool({
        name: 'delete',
        annotations: { destructiveHint: true },
      }),
      {
        id: 'delete',
        name: 'delete',
        description: '',
        annotations: { destructiveHint: true },
      },
    );
    assert.deepEqual(toUiTool({ name: 'search', annotations: { title: 'Search' } }), {
      id: 'search',
      name: 'search',
      description: '',
    });
  });

  it('builds upsert manifests from UI create/update requests', () => {
    assert.deepEqual(
      toHarnessManifest({
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        auth: { type: 'dcr' },
      }),
      {
        type: 'remote',
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        description: 'linear MCP server',
        auth: { type: 'dcr' },
      },
    );
    assert.deepEqual(
      toHarnessManifest({
        name: 'custom-mcp',
        url: 'https://example.com/mcp',
        auth: { type: 'none' },
      }),
      {
        type: 'remote',
        name: 'custom-mcp',
        url: 'https://example.com/mcp',
        description: 'custom-mcp MCP server',
      },
    );
    assert.deepEqual(
      toHarnessManifest({
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        auth: { type: 'dcr' },
        description: 'Linear MCP server.',
      }),
      {
        type: 'remote',
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        description: 'Linear MCP server.',
        auth: { type: 'dcr' },
      },
    );
    assert.deepEqual(
      toHarnessManifest({
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        auth: { type: 'dcr' },
        description: '   ',
      }),
      {
        type: 'remote',
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        description: 'linear MCP server',
        auth: { type: 'dcr' },
      },
    );
  });

  it('forwards memoryProvider onto the harness manifest', () => {
    assert.deepEqual(
      toHarnessManifest({
        name: 'hindsight',
        url: 'https://memory.example/mcp/default/',
        auth: { type: 'none' },
        memoryProvider: true,
      }),
      {
        type: 'remote',
        name: 'hindsight',
        url: 'https://memory.example/mcp/default/',
        description: 'hindsight MCP server',
        memoryProvider: true,
      },
    );
    assert.deepEqual(
      toHarnessManifest({
        name: 'hindsight',
        url: 'https://memory.example/mcp/default/',
        auth: { type: 'none' },
        memoryProvider: false,
      }),
      {
        type: 'remote',
        name: 'hindsight',
        url: 'https://memory.example/mcp/default/',
        description: 'hindsight MCP server',
        memoryProvider: false,
      },
    );
  });

  it('omits memoryProvider from the harness manifest when unset', () => {
    assert.deepEqual(
      toHarnessManifest({
        name: 'hindsight',
        url: 'https://memory.example/mcp/default/',
        auth: { type: 'none' },
      }),
      {
        type: 'remote',
        name: 'hindsight',
        url: 'https://memory.example/mcp/default/',
        description: 'hindsight MCP server',
      },
    );
  });
});

describe('connectorCatalog memory-provider check', () => {
  const client = new TrueForge({ baseUrl: 'http://harness.test' });

  function catalogWithFetch(fetchImpl: typeof fetch) {
    return createConnectorCatalog(client, { baseUrl: 'http://harness.test', fetch: fetchImpl });
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('posts to the memory-check route and maps a healthy result', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const catalog = catalogWithFetch(async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return jsonResponse({ data: { status: 'ok' } });
    });

    assert.deepEqual(await catalog.checkMemoryProvider({ id: 'hindsight' }), { ok: true });
    assert.deepEqual(calls, [{ url: 'http://harness.test/api/v1/mcp-servers/hindsight/memory-check', method: 'POST' }]);
  });

  it('maps a failed check onto the reason the provider gave', async () => {
    const catalog = catalogWithFetch(async () =>
      jsonResponse({
        data: {
          status: 'failed',
          code: 'http_error',
          reason: 'recall returned HTTP 401: Authentication failed: Invalid API key',
          http_status: 401,
          detail: 'Authentication failed: Invalid API key',
        },
      }),
    );

    assert.deepEqual(await catalog.checkMemoryProvider({ id: 'hindsight' }), {
      ok: false,
      code: 'http_error',
      reason: 'recall returned HTTP 401: Authentication failed: Invalid API key',
    });
  });

  it('throws the API error message when the route rejects the request', async () => {
    const catalog = catalogWithFetch(async () =>
      jsonResponse({ error: { message: 'MCP server not found: nope' } }, 404),
    );

    await assert.rejects(() => catalog.checkMemoryProvider({ id: 'nope' }), /MCP server not found: nope/);
  });
});

describe('connectorCatalog tool grants', () => {
  const client = new TrueForge({ baseUrl: 'http://harness.test' });

  function catalogWithFetch(fetchImpl: typeof fetch) {
    return createConnectorCatalog(client, { baseUrl: 'http://harness.test', fetch: fetchImpl });
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it("lists the caller's always-allowed tools", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const catalog = catalogWithFetch(async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return jsonResponse({ data: [{ tool_name: 'lookup_note', created_at: '2026-10-10T00:00:00.000Z' }] });
    });

    assert.deepEqual(await catalog.listToolGrants({ id: 'notes' }), ['lookup_note']);
    assert.deepEqual(calls, [{ url: 'http://harness.test/api/v1/mcp-servers/notes/tool-grants', method: 'GET' }]);
  });

  it('revokes one tool by name', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const catalog = catalogWithFetch(async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return jsonResponse({});
    });

    await catalog.revokeToolGrant({ id: 'notes', toolName: 'lookup note' });
    assert.deepEqual(calls, [
      { url: 'http://harness.test/api/v1/mcp-servers/notes/tool-grants/lookup%20note', method: 'DELETE' },
    ]);
  });

  it('throws the API error message when the route rejects the request', async () => {
    const catalog = catalogWithFetch(async () =>
      jsonResponse({ error: { message: 'MCP server not found: nope' } }, 404),
    );

    await assert.rejects(() => catalog.listToolGrants({ id: 'nope' }), /MCP server not found: nope/);
  });

  it('rejects an unreadable listing instead of guessing', async () => {
    const catalog = catalogWithFetch(async () => jsonResponse({ data: [{ name: 'lookup_note' }] }));

    await assert.rejects(() => catalog.listToolGrants({ id: 'notes' }), /unreadable response/);
  });
});

describe('connectorCatalog connection test', () => {
  function catalogWithFetch(fetchImpl: typeof fetch) {
    // maxRetries 0 so a 502 fixture is not retried with backoff before it is reported.
    const client = new TrueForge({ baseUrl: 'http://harness.test', maxRetries: 0, fetch: fetchImpl });
    return createConnectorCatalog(client, { baseUrl: 'http://harness.test' });
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('dials the tools route and reports the tools the connector answered with', async () => {
    const urls: string[] = [];
    const catalog = catalogWithFetch(async input => {
      urls.push(String(input));
      return jsonResponse({ data: [{ name: 'search', description: 'Find docs' }, { name: 'fetch' }] });
    });

    assert.deepEqual(await catalog.testConnector({ id: 'parallel-web' }), {
      ok: true,
      toolNames: ['search', 'fetch'],
    });
    assert.deepEqual(urls, ['http://harness.test/api/v1/mcp-servers/parallel-web/tools']);
  });

  it('classifies a 422 as authentication and keeps the API message', async () => {
    const catalog = catalogWithFetch(async () =>
      jsonResponse({ error: { message: 'MCP server "linear" requires authentication' } }, 422),
    );

    assert.deepEqual(await catalog.testConnector({ id: 'linear' }), {
      ok: false,
      kind: 'auth_required',
      message: 'MCP server "linear" requires authentication',
    });
  });

  it('classifies a 502 as unreachable and keeps the API message', async () => {
    const catalog = catalogWithFetch(async () =>
      jsonResponse({ error: { message: 'connect ECONNREFUSED 127.0.0.1:9999' } }, 502),
    );

    assert.deepEqual(await catalog.testConnector({ id: 'broken' }), {
      ok: false,
      kind: 'unreachable',
      message: 'connect ECONNREFUSED 127.0.0.1:9999',
    });
  });

  it('reports any other status as it arrived rather than guessing a cause', async () => {
    const catalog = catalogWithFetch(async () =>
      jsonResponse({ error: { message: 'MCP server not found: nope' } }, 404),
    );

    assert.deepEqual(await catalog.testConnector({ id: 'nope' }), {
      ok: false,
      kind: 'error',
      message: 'MCP server not found: nope',
    });
  });
});

describe('connectorCatalog delete', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function catalogWithFetch(fetchImpl: typeof fetch) {
    const client = new TrueForge({ baseUrl: 'http://harness.test', maxRetries: 0, fetch: fetchImpl });
    return createConnectorCatalog(client, { baseUrl: 'http://harness.test' });
  }

  it('issues a DELETE against the server row and resolves once it succeeds', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const catalog = catalogWithFetch(async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await catalog.deleteConnector?.({ id: 'parallel-web' });

    assert.deepEqual(calls, [
      { url: 'http://harness.test/api/v1/settings/mcp-servers/parallel-web', method: 'DELETE' },
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
    const pending = catalog.deleteConnector?.({ id: 'parallel-web' });
    assert.ok(pending, 'deleteConnector should be present on the catalog');
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
    // deleteConnector's own request-level `maxRetries: 0` is what suppresses them.
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
    const catalog = createConnectorCatalog(client, { baseUrl: 'http://harness.test' });

    await assert.rejects(catalog.deleteConnector?.({ id: 'parallel-web' }) as Promise<unknown>);

    assert.equal(calls.length, 1);
  });
});
