import { createLogger } from 'winston';
import { RemoteMCP, ToolSet, createSentinelHostContext, createWebSearchTurnState, defaultSentinelServices } from '../../../src/core';
import type { ToolSchema } from '../../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import { FetchedPageStore } from '../../../src/core/search/fetchedPages';
import { groundPlace } from '../../../src/core/search/groundPlace';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';

jest.mock('../../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../../src/core/mcp/remoteMcpClient')>(
    '../../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);
const noopLogger = createLogger({ silent: true });
const schema = { type: 'object' as const, properties: {} };

function searchTool(name: string): ToolSchema {
  return {
    name,
    description: 'Searches the web.',
    inputSchema: schema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  };
}
function fetchTool(name: string): ToolSchema {
  return {
    name,
    description: 'Reads a page.',
    inputSchema: schema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  };
}

const PAGE_URL = 'https://hope-house.example/';
const PAGE_TEXT = 'Hope House\n916 St. Andrew Street, New Orleans\nA food pantry open to everyone.';

function harness(
  result: (name: string) => string,
  toolNames: { search: string; fetch: string } = { search: 'web_search', fetch: 'web_fetch' },
): { toolSet: ToolSet; pages: FetchedPageStore } {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: [searchTool(toolNames.search), fetchTool(toolNames.fetch)] }),
      callTool: callParams =>
        Promise.resolve({ content: [{ type: 'text', text: result(callParams.name) }] }),
      close: () => Promise.resolve(),
    }),
  );
  const host = createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    web_search: createWebSearchTurnState(),
  });
  const pages = new FetchedPageStore({ now: () => Date.parse('2026-10-17T10:00:00Z'), ttlMs: 60_000, maxPages: 10 });
  const toolSet = new ToolSet({
    source: new RemoteMCP({
      name: 'finder',
      id: 'finder',
      url: 'https://search.example.com/mcp',
      headers: {},
      logger: noopLogger,
      tracing: NOOP_AGENT_TRACING,
      requestTimeoutMs: 60_000,
      connectTimeoutMs: 5_000,
      signal: new AbortController().signal,
    }),
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [] },
    preload: false,
    sentinel: host,
    searchProvider: { tools: [toolNames.search, toolNames.fetch], plumbing_fields: [] },
    pages,
  });
  return { toolSet, pages };
}

describe('ToolSet records pages read through the search provider', () => {
  it('records a page read with web_fetch, so a place from it can be pinned', async () => {
    const fetched = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: { results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] },
    });
    const { toolSet, pages } = harness(name => (name === 'web_fetch' ? fetched : 'called'));
    await toolSet.callTool({ name: 'web_fetch', arguments: { url: PAGE_URL } }, { status: 'allow' });
    expect(pages.recall(PAGE_URL)?.text).toBe(PAGE_TEXT);
    expect(
      groundPlace({
        claim: {
          name: 'Hope House',
          address: '916 St Andrew St',
          languages: null,
          hours: null,
          price: null,
          phone: null,
          source_url: PAGE_URL,
        },
        pages,
      }),
    ).toMatchObject({ ok: true });
  });

  it('does not record search results as read pages', async () => {
    const searched = JSON.stringify({ results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] });
    const { toolSet, pages } = harness(() => searched);
    await toolSet.callTool({ name: 'web_search', arguments: { query: 'food pantry New Orleans' } }, { status: 'allow' });
    expect(pages.recall(PAGE_URL)).toBeUndefined();
  });

  it('does not record a search result when the search text is itself the link', async () => {
    const searched = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: { results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] },
    });
    const { toolSet, pages } = harness(() => searched);
    await toolSet.callTool({ name: 'web_search', arguments: { query: PAGE_URL } }, { status: 'allow' });
    expect(pages.recall(PAGE_URL)).toBeUndefined();
  });
});

describe('ToolSet records pages read through a Tavily shaped server', () => {
  const names = { search: 'tavily_search', fetch: 'tavily_extract' };

  it('does not record a search result when the search text is itself the link', async () => {
    const searched = JSON.stringify({ results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] });
    const { toolSet, pages } = harness(() => searched, names);
    await toolSet.callTool({ name: 'tavily_search', arguments: { query: PAGE_URL } }, { status: 'allow' });
    expect(pages.recall(PAGE_URL)).toBeUndefined();
  });

  it('records the pages an extract read, so a place from one can be pinned', async () => {
    const extracted = JSON.stringify({ results: [{ url: PAGE_URL, title: 'Hope House', raw_content: PAGE_TEXT }] });
    const { toolSet, pages } = harness(() => extracted, names);
    await toolSet.callTool({ name: 'tavily_extract', arguments: { urls: [PAGE_URL] } }, { status: 'allow' });
    expect(pages.recall(PAGE_URL)?.text).toBe(PAGE_TEXT);
  });
});
