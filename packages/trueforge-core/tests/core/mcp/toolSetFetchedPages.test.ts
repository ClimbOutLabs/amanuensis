import { createLogger } from 'winston';
import {
  RemoteMCP,
  ToolSet,
  createSentinelHostContext,
  createWebSearchTurnState,
  defaultSentinelServices,
} from '../../../src/core';
import type { ToolSchema } from '../../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import { FetchedPageStore, type FetchedPageScope } from '../../../src/core/search/fetchedPages';
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

const CHAT_SCOPE: FetchedPageScope = { tenant_id: 't1', conversation_id: 'c1' };

function harness(
  result: (name: string) => string,
  toolNames: { search: string; fetch: string } = { search: 'web_search', fetch: 'web_fetch' },
  shared?: { pages: FetchedPageStore; scope: FetchedPageScope },
): { toolSet: ToolSet; pages: FetchedPageStore; scope: FetchedPageScope } {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: [searchTool(toolNames.search), fetchTool(toolNames.fetch)] }),
      callTool: callParams => Promise.resolve({ content: [{ type: 'text', text: result(callParams.name) }] }),
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
  const pages =
    shared?.pages ??
    new FetchedPageStore({ now: () => Date.parse('2026-10-17T10:00:00Z'), ttlMs: 60_000, maxPages: 10 });
  const scope = shared?.scope ?? CHAT_SCOPE;
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
    pagesScope: scope,
  });
  return { toolSet, pages, scope };
}

const hopeClaim = {
  name: 'Hope House',
  address: '916 St Andrew St',
  languages: null,
  hours: null,
  price: null,
  phone: null,
  source_url: PAGE_URL,
};

describe('ToolSet records pages read through the search provider', () => {
  it('records a page read with web_fetch, so a place from it can be pinned', async () => {
    const fetched = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: { results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] },
    });
    const { toolSet, pages, scope } = harness(name => (name === 'web_fetch' ? fetched : 'called'));
    await toolSet.callTool({ name: 'web_fetch', arguments: { url: PAGE_URL } }, { status: 'allow' });
    expect(pages.recall({ scope, url: PAGE_URL })?.text).toBe(PAGE_TEXT);
    expect(groundPlace({ claim: hopeClaim, pages, scope })).toMatchObject({ ok: true });
  });

  it('keeps a page read in one chat out of another chat sharing the same memory', async () => {
    const fetched = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: { results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] },
    });
    const sharedPages = new FetchedPageStore({
      now: () => Date.parse('2026-10-17T10:00:00Z'),
      ttlMs: 60_000,
      maxPages: 10,
    });
    const otherChatScope: FetchedPageScope = { tenant_id: 't1', conversation_id: 'c2' };
    harness(() => 'called', undefined, { pages: sharedPages, scope: otherChatScope });
    const chatA = harness(name => (name === 'web_fetch' ? fetched : 'called'), undefined, {
      pages: sharedPages,
      scope: CHAT_SCOPE,
    });
    await chatA.toolSet.callTool({ name: 'web_fetch', arguments: { url: PAGE_URL } }, { status: 'allow' });
    expect(sharedPages.recall({ scope: otherChatScope, url: PAGE_URL })).toBeUndefined();
    expect(groundPlace({ claim: hopeClaim, pages: sharedPages, scope: otherChatScope })).toEqual({
      ok: false,
      reason: 'source_not_fetched',
    });
    expect(groundPlace({ claim: hopeClaim, pages: sharedPages, scope: CHAT_SCOPE })).toMatchObject({ ok: true });
  });

  it('records search results as sources, each under its own link', async () => {
    const searched = JSON.stringify({ results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] });
    const { toolSet, pages, scope } = harness(() => searched);
    await toolSet.callTool(
      { name: 'web_search', arguments: { query: 'food pantry New Orleans' } },
      { status: 'allow' },
    );
    expect(pages.recall({ scope, url: PAGE_URL })?.text).toContain('A food pantry open to everyone.');
  });

  it('does not record a search result when the search text is itself the link', async () => {
    const searched = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: { results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] },
    });
    const { toolSet, pages, scope } = harness(() => searched);
    await toolSet.callTool({ name: 'web_search', arguments: { query: PAGE_URL } }, { status: 'allow' });
    expect(pages.recall({ scope, url: PAGE_URL })).toBeUndefined();
  });
});

describe('ToolSet records pages read through a Tavily shaped server', () => {
  const names = { search: 'tavily_search', fetch: 'tavily_extract' };

  it('records a search result, but never the query the search was run with', async () => {
    const searched = JSON.stringify({
      query: 'pantry open late uptown',
      results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }],
    });
    const { toolSet, pages, scope } = harness(() => searched, names);
    await toolSet.callTool(
      { name: 'tavily_search', arguments: { query: 'pantry open late uptown' } },
      { status: 'allow' },
    );
    const recorded = pages.recall({ scope, url: PAGE_URL })?.text ?? '';
    expect(recorded).toContain('Hope House');
    expect(recorded).not.toContain('open late uptown');
  });

  it('records nothing from a search whose text names a link', async () => {
    const searched = JSON.stringify({ results: [{ url: PAGE_URL, title: 'Hope House', content: PAGE_TEXT }] });
    const { toolSet, pages, scope } = harness(() => searched, names);
    await toolSet.callTool({ name: 'tavily_search', arguments: { query: PAGE_URL } }, { status: 'allow' });
    expect(pages.recall({ scope, url: PAGE_URL })).toBeUndefined();
  });

  it('records the pages an extract read, so a place from one can be pinned', async () => {
    const extracted = JSON.stringify({ results: [{ url: PAGE_URL, title: 'Hope House', raw_content: PAGE_TEXT }] });
    const { toolSet, pages, scope } = harness(() => extracted, names);
    await toolSet.callTool({ name: 'tavily_extract', arguments: { urls: [PAGE_URL] } }, { status: 'allow' });
    expect(pages.recall({ scope, url: PAGE_URL })?.text).toBe(PAGE_TEXT);
  });
});

describe('a page reader listed as a search tool never records search results', () => {
  const NAMED_URL = 'https://named.example/';
  const NEVER_NAMED_URL = 'https://never-named.example/';
  const readerOutput = JSON.stringify({
    results: [{ url: NEVER_NAMED_URL, title: 'Hope House', snippet: PAGE_TEXT }],
  });

  it.each([
    ['web_fetch_exa', { search: 'web_search_exa', fetch: 'web_fetch_exa' }, { urls: [NAMED_URL] }],
    ['tavily_extract', { search: 'tavily_search', fetch: 'tavily_extract' }, { urls: [NAMED_URL] }],
    ['web_fetch', { search: 'web_search', fetch: 'web_fetch' }, { url: NAMED_URL }],
  ])('%s: a link its output lists but the call never named cannot ground a place', async (name, names, args) => {
    const { toolSet, pages, scope } = harness(() => readerOutput, names);
    await toolSet.callTool({ name, arguments: args }, { status: 'allow' });
    expect(pages.recall({ scope, url: NEVER_NAMED_URL })).toBeUndefined();
    expect(groundPlace({ claim: { ...hopeClaim, source_url: NEVER_NAMED_URL }, pages, scope })).toEqual({
      ok: false,
      reason: 'source_not_fetched',
    });
  });
});

describe('a search result that repeats the query is not a source', () => {
  it('records no result whose title echoes the query, so its place cannot be pinned', async () => {
    const echoUrl = 'https://echo.example/results';
    const query = 'Dr Ana Ruiz 14 Hidden Orchard Lane Springfield';
    const searched = JSON.stringify({ results: [{ url: echoUrl, title: query, snippet: 'No results found.' }] });
    const { toolSet, pages, scope } = harness(() => searched);
    await toolSet.callTool({ name: 'web_search', arguments: { query } }, { status: 'allow' });
    expect(pages.recall({ scope, url: echoUrl })).toBeUndefined();
    const claim = { ...hopeClaim, name: 'Dr Ana Ruiz', address: '14 Hidden Orchard Lane', source_url: echoUrl };
    expect(groundPlace({ claim, pages, scope })).toMatchObject({ ok: false, reason: 'source_not_fetched' });
  });
});

describe('ToolSet records only pages Aman reads itself', () => {
  const ECHOES: [string, string, string][] = [
    [
      'a path with plus signs shown as spaces',
      'https://site.example/Joe+Cafe+12+Main+St',
      'Result for https://site.example/Joe Cafe 12 Main St',
    ],
    [
      'a query string shown with spaces',
      'https://site.example/?name=Joe+Cafe&addr=12+Main+St',
      'Result for https://site.example/?name=Joe Cafe&addr=12 Main St',
    ],
    [
      'a fragment shown with spaces',
      'https://site.example/listing#Joe+Cafe+12+Main+St',
      'Result for https://site.example/listing#Joe Cafe 12 Main St',
    ],
    [
      'a path decoded twice',
      'https://site.example/Joe%2520Cafe%252012%2520Main%2520St',
      'Result for https://site.example/Joe Cafe 12 Main St',
    ],
  ];

  it.each(ECHOES)(
    'refuses a place whose only page is %s echoed by a tool that is not a page reader',
    async (_label, url, text) => {
      const { toolSet, pages, scope } = harness(() => text, { search: 'web_search', fetch: 'lookup_listing' });
      await toolSet.callTool({ name: 'lookup_listing', arguments: { url } }, { status: 'allow' });
      expect(
        groundPlace({
          claim: { ...hopeClaim, name: 'Joe Cafe', address: '12 Main St', source_url: url },
          pages,
          scope,
        }),
      ).toEqual({ ok: false, reason: 'source_not_fetched' });
    },
  );

  it('still grounds a place from a plain text page that the host web_fetch read', async () => {
    const { toolSet, pages, scope } = harness(name => (name === 'web_fetch' ? PAGE_TEXT : 'called'));
    await toolSet.callTool({ name: 'web_fetch', arguments: { url: PAGE_URL } }, { status: 'allow' });
    expect(groundPlace({ claim: hopeClaim, pages, scope })).toMatchObject({ ok: true });
  });
});

describe('a page reader that echoes its own link cannot ground a place from that link', () => {
  const ECHOED_LINKS: [string, string][] = [
    ['a path with plus signs', 'https://site.example/Joe+Cafe+12+Main+St'],
    ['a path with %20 escapes', 'https://site.example/Joe%20Cafe%2012%20Main%20St'],
    ['a path encoded twice', 'https://site.example/Joe%2520Cafe%252012%2520Main%2520St'],
    ['a query string only', 'https://site.example/?name=Joe+Cafe&addr=12+Main+St'],
    ['a path only', 'https://site.example/joe-cafe/12-main-st'],
    ['a fragment only', 'https://site.example/listing#Joe+Cafe+12+Main+St'],
  ];

  it.each(ECHOED_LINKS)('refuses a place whose words only come from %s that web_fetch echoed', async (_label, url) => {
    const { toolSet, pages, scope } = harness(name => (name === 'web_fetch' ? `Could not read ${url}` : 'called'));
    await toolSet.callTool({ name: 'web_fetch', arguments: { url } }, { status: 'allow' });
    expect(
      groundPlace({ claim: { ...hopeClaim, name: 'Joe Cafe', address: '12 Main St', source_url: url }, pages, scope }),
    ).toEqual({ ok: false, reason: 'place_only_in_address' });
  });

  it('still grounds a real page at a plain link with no place words in it', async () => {
    const url = 'https://listings.example/food';
    const { toolSet, pages, scope } = harness(name => (name === 'web_fetch' ? PAGE_TEXT : 'called'));
    await toolSet.callTool({ name: 'web_fetch', arguments: { url } }, { status: 'allow' });
    expect(groundPlace({ claim: { ...hopeClaim, source_url: url }, pages, scope })).toMatchObject({ ok: true });
  });
});
