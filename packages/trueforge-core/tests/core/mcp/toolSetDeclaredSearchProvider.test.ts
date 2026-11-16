import { createLogger } from 'winston';
import {
  RemoteMCP,
  ToolSet,
  createSentinelHostContext,
  createWebSearchTurnState,
  defaultSentinelServices,
  type SearchProviderGrant,
} from '../../../src/core';
import type { ToolSchema } from '../../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import { FetchedPageStore, type FetchedPageScope } from '../../../src/core/search/fetchedPages';
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

/**
 * Finding 4: an invented search server, designated by the person, whose declaration the host
 * captured from its own tool list. Its tool names appear in no preset and no list anywhere,
 * so every effect below (silent running, search hits recorded, pages recorded, the stamps
 * later provenance reads) can only come from the declaration on its connector record.
 */
const MOON_TOOLS: ToolSchema[] = [
  { name: 'moon_search', description: 'Searches the moon archive.', inputSchema: schema, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'moon_fetch', description: 'Reads one moon page.', inputSchema: schema, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'moon_write', description: 'Writes to the moon archive.', inputSchema: schema, annotations: { readOnlyHint: false } },
];

const MOON_GRANT: SearchProviderGrant = {
  tools: ['moon_search'],
  page_read_tools: ['moon_fetch'],
  plumbing_fields: [],
  served_in_process: false,
};

const PAGE_URL = 'https://moon.example/tides';
const PAGE_TEXT = 'Moon Tides\nThe harbour office posts the tide table every morning.';
const SCOPE: FetchedPageScope = { tenant_id: 't1', conversation_id: 'c1' };

function harness(grant: SearchProviderGrant | undefined) {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: MOON_TOOLS }),
      callTool: callParams =>
        Promise.resolve({
          content: [
            {
              type: 'text',
              text:
                callParams.name === 'moon_search'
                  ? JSON.stringify({ results: [{ url: PAGE_URL, title: 'Moon Tides', content: PAGE_TEXT }] })
                  : JSON.stringify({ results: [{ url: PAGE_URL, title: 'Moon Tides', content: PAGE_TEXT }] }),
            },
          ],
        }),
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
      name: 'moon',
      id: 'moon',
      url: 'https://moon.example/mcp',
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
    searchProvider: grant,
    pages,
    pagesScope: SCOPE,
  });
  return { toolSet, pages };
}

describe('a designated provider nobody shipped a preset for', () => {
  it('records its declared search tool’s results as search hits, so their links are vouched', async () => {
    const { toolSet, pages } = harness(MOON_GRANT);
    await toolSet.callTool({ name: 'moon_search', arguments: { query: 'tides' } }, { status: 'allow' });
    const recorded = pages.recall({ scope: SCOPE, url: PAGE_URL });
    expect(recorded?.text).toContain('tide table');
    expect(recorded?.is_snippet).toBe(true);
    expect(recorded?.from_search).toBe(true);
  });

  it('records its declared page reader’s results as pages, never as search hits', async () => {
    const { toolSet, pages } = harness(MOON_GRANT);
    await toolSet.callTool({ name: 'moon_fetch', arguments: { urls: [PAGE_URL] } }, { status: 'allow' });
    const recorded = pages.recall({ scope: SCOPE, url: PAGE_URL });
    expect(recorded?.text).toContain('tide table');
    expect(recorded?.is_snippet).toBe(false);
  });

  it('stamps its calls with the roles its record declares, for provenance to read later', async () => {
    const { toolSet } = harness(MOON_GRANT);
    const searchInfo = await toolSet.toolCallInfo({ name: 'moon_search', arguments: { query: 'tides' } });
    expect(searchInfo.search_provider_call).toBe(true);
    expect(searchInfo.search_result_call).toBe(true);
    expect(searchInfo.page_read_call).toBeUndefined();
    const fetchInfo = await toolSet.toolCallInfo({ name: 'moon_fetch', arguments: { urls: [PAGE_URL] } });
    expect(fetchInfo.page_read_call).toBe(true);
    expect(fetchInfo.search_result_call).toBeUndefined();
    const writeInfo = await toolSet.toolCallInfo({ name: 'moon_write', arguments: {} });
    expect(writeInfo.search_result_call).toBeUndefined();
    expect(writeInfo.page_read_call).toBeUndefined();
  });

  it('records nothing and stamps nothing for the same server when it is not designated', async () => {
    const { toolSet, pages } = harness(undefined);
    await toolSet.callTool({ name: 'moon_search', arguments: { query: 'tides' } }, { status: 'allow' });
    await toolSet.callTool({ name: 'moon_fetch', arguments: { urls: [PAGE_URL] } }, { status: 'allow' });
    expect(pages.recall({ scope: SCOPE, url: PAGE_URL })).toBeUndefined();
    const info = await toolSet.toolCallInfo({ name: 'moon_search', arguments: { query: 'tides' } });
    expect(info.search_provider_call).toBeUndefined();
    expect(info.search_result_call).toBeUndefined();
  });
});
