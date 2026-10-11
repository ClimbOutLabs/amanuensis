import { createLogger } from 'winston';
import {
  RemoteMCP,
  ToolSet,
  createSentinelHostContext,
  createWebSearchTurnState,
  defaultSentinelServices,
  type SentinelHostContext,
} from '../../../src/core';
import {
  isApprovalRequiredResponse,
  isCallToolResponseResult,
  type ToolSchema,
} from '../../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import { forUnattendedRun, type SentinelServices } from '../../../src/core/permissions/context';
import { SILENT_SEARCH_LIMIT } from '../../../src/core/permissions/webSearch';
import { toToolCallInfo } from '../../../src/core/runtime/contextUtils';
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

const searchTool: ToolSchema = {
  name: 'lookup',
  description: 'Looks things up on the web.',
  inputSchema: schema,
  annotations: { readOnlyHint: true, openWorldHint: true },
};
const fetchTool: ToolSchema = { name: 'read_page', description: 'Reads a page.', inputSchema: schema };
const writingTool: ToolSchema = {
  name: 'annotate',
  description: 'Writes an annotation.',
  inputSchema: schema,
  annotations: { readOnlyHint: false },
};
const destructiveTool: ToolSchema = {
  name: 'lookup_and_log',
  description: 'Looks up and logs.',
  inputSchema: schema,
  annotations: { destructiveHint: true },
};

interface Harness {
  toolSet: ToolSet;
  host: SentinelHostContext;
  audit: AuditRecordInput[];
  dispatched: { name: string; args: unknown }[];
}

function harness(options: {
  serverName?: string;
  searchProvider?: boolean;
  unattended?: boolean;
  searchWithoutAsking?: boolean;
  secrets?: readonly string[];
  result?: (name: string) => string;
  requireApprovalForTools?: string[];
}): Harness {
  const audit: AuditRecordInput[] = [];
  const dispatched: { name: string; args: unknown }[] = [];
  let services: SentinelServices = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    audit: {
      record: input => {
        audit.push(input);
        return Promise.resolve();
      },
    },
    searchWithoutAsking: () => Promise.resolve(options.searchWithoutAsking ?? true),
    outboundSecrets: () => Promise.resolve(options.secrets ?? []),
  };
  if (options.unattended === true) {
    services = forUnattendedRun(services);
  }
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: [searchTool, fetchTool, writingTool, destructiveTool] }),
      callTool: callParams => {
        dispatched.push({ name: callParams.name, args: callParams.arguments });
        return Promise.resolve({
          content: [{ type: 'text', text: options.result?.(callParams.name) ?? `called ${callParams.name}` }],
        });
      },
      close: () => Promise.resolve(),
    }),
  );
  const serverName = options.serverName ?? 'finder';
  const host = createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    services,
    web_search: createWebSearchTurnState(),
  });
  const toolSet = new ToolSet({
    source: new RemoteMCP({
      name: serverName,
      id: serverName,
      url: 'https://search.example.com/mcp',
      headers: {},
      logger: noopLogger,
      tracing: NOOP_AGENT_TRACING,
      requestTimeoutMs: 60_000,
      connectTimeoutMs: 5_000,
      signal: new AbortController().signal,
    }),
    selectors: {
      enableTools: ['@all'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: options.requireApprovalForTools,
    },
    preload: false,
    sentinel: host,
    searchProvider: options.searchProvider,
  });
  return { toolSet, host, audit, dispatched };
}

async function runSearch(h: Harness, query: string) {
  return h.toolSet.callTool({ name: 'lookup', arguments: { query } });
}

describe('the designated search provider', () => {
  it('runs its search tool without asking, shows the query as a chip, and audits the run once', async () => {
    const h = harness({ searchProvider: true });

    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'tallest building in Lisbon' } });
    expect(info.tier).toBe(1);
    expect(info.is_approval_required).toBe(false);
    expect(info.silent_search_query).toBe('tallest building in Lisbon');
    expect(toToolCallInfo(info)).toMatchObject({ type: 'mcp', silent_search_query: 'tallest building in Lisbon' });
    // Classification runs several times per call; only the dispatch is the run.
    expect(h.audit).toEqual([]);

    const response = await runSearch(h, 'tallest building in Lisbon');
    expect(isCallToolResponseResult(response)).toBe(true);
    expect(h.dispatched).toHaveLength(1);
    expect(h.audit).toEqual([
      expect.objectContaining({
        tier: 1,
        tool_name: 'lookup',
        outcome: 'logged',
        description: 'Searched: tallest building in Lisbon',
        conversation_id: 'c1',
      }),
    ]);
  });

  it('runs a tool that publishes no hints, because the user designated the connector', async () => {
    const h = harness({ searchProvider: true });
    const info = await h.toolSet.toolCallInfo({ name: 'read_page', arguments: { query: 'weather in Oslo' } });
    expect(info.tier).toBe(1);
    // The default approval selectors would gate an unannotated tool; the designation waives that.
    expect(info.is_approval_required).toBe(false);
  });

  it('still honors a selector that names the tool', async () => {
    const h = harness({ searchProvider: true, requireApprovalForTools: ['lookup'] });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'weather in Oslo' } });
    expect(info.tier).toBe(1);
    expect(info.is_approval_required).toBe(true);
  });

  it('never lowers a tool that declares itself destructive or not read-only', async () => {
    const h = harness({ searchProvider: true });
    expect((await h.toolSet.toolCallInfo({ name: 'annotate', arguments: { query: 'weather' } })).tier).toBe(3);
    expect((await h.toolSet.toolCallInfo({ name: 'lookup_and_log', arguments: { query: 'weather' } })).tier).toBe(3);
  });

  it('leaves the same tool on a connector that is not designated asking', async () => {
    const h = harness({ searchProvider: false, serverName: 'web_search' });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'weather in Oslo' } });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
    expect(info.silent_search_query).toBeUndefined();
    const response = await runSearch(h, 'weather in Oslo');
    expect(isApprovalRequiredResponse(response)).toBe(true);
    expect(h.dispatched).toEqual([]);
  });

  it('asks, showing the exact query, when the user switched searches to Ask', async () => {
    const h = harness({ searchProvider: true, searchWithoutAsking: false });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'weather in Oslo' } });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
    expect(info.tier3_card?.plain_what).toContain('weather in Oslo');
    expect(info.silent_search_query).toBeUndefined();
  });

  it('keeps asking in a scheduled run when the user chose Ask', async () => {
    const h = harness({ searchProvider: true, searchWithoutAsking: false, unattended: true });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'weather in Oslo' } });
    expect(info.tier).toBe(3);
    expect(info.pre_dispatch_failure).toBeUndefined();
  });
});

describe('the outbound guard on the designated provider', () => {
  const secret = 'synthetic-provider-key-000111';

  it('asks in an interactive chat, with the exact query on the card and no silent run', async () => {
    const h = harness({ searchProvider: true, secrets: [secret] });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: `debug ${secret}` } });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
    expect(info.pre_dispatch_failure).toBeUndefined();
    expect(info.tier3_card?.plain_what).toContain(secret);
    expect(info.tier3_card?.why_asked_again).toContain('secret this server holds');
    expect(info.silent_search_query).toBeUndefined();
    expect(h.audit).toEqual([]);
  });

  it('denies in a scheduled run, audits the rule without the query, and lets the run continue', async () => {
    const h = harness({ searchProvider: true, secrets: [secret], unattended: true });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: `debug ${secret}` } });
    expect(info.is_approval_required).toBe(false);
    expect(info.pre_dispatch_failure).toEqual({
      kind: 'policy_blocked',
      message: expect.stringContaining('Auto-denied'),
    });
    expect(info.pre_dispatch_failure?.message).not.toContain(secret);
    expect(h.audit).toEqual([
      expect.objectContaining({ tier: 3, outcome: 'auto_denied', auto_deny_reason: 'outbound_guard' }),
    ]);
    expect(JSON.stringify(h.audit)).not.toContain(secret);
    expect(h.dispatched).toEqual([]);
  });

  it('holds a private key block, and a long query, the same way', async () => {
    const h = harness({ searchProvider: true, unattended: true });
    const header = ['-----BEGIN ', 'EC ', 'PRIVATE ', 'KEY-----'].join('');
    expect(
      (await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: header } })).pre_dispatch_failure,
    ).toBeDefined();
    const long = 'weather forecast for the coming week '.repeat(8);
    expect(
      (await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: long } })).pre_dispatch_failure,
    ).toBeDefined();
  });

  it('reads every string argument, not only a field called query', async () => {
    const h = harness({ searchProvider: true, secrets: [secret], unattended: true });
    const info = await h.toolSet.toolCallInfo({
      name: 'lookup',
      arguments: { objective: 'weather', search_queries: ['oslo', { nested: secret }] },
    });
    expect(info.pre_dispatch_failure).toBeDefined();
  });
});

describe('the loop breaker', () => {
  it('asks once the turn has run its silent searches', async () => {
    const h = harness({ searchProvider: true });
    for (let i = 0; i < SILENT_SEARCH_LIMIT; i += 1) {
      expect((await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: `topic ${String(i)}` } })).tier).toBe(
        1,
      );
      await runSearch(h, `topic ${String(i)}`);
    }
    expect(h.host.web_search.silentSearches).toBe(SILENT_SEARCH_LIMIT);
    const next = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'one more' } });
    expect(next.tier).toBe(3);
    expect(next.is_approval_required).toBe(true);
    expect(next.tier3_card?.why_asked_again).toContain(String(SILENT_SEARCH_LIMIT));
  });

  it('denies instead in a scheduled run', async () => {
    const h = harness({ searchProvider: true, unattended: true });
    h.host.web_search.silentSearches = SILENT_SEARCH_LIMIT;
    const next = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'one more' } });
    expect(next.pre_dispatch_failure?.kind).toBe('policy_blocked');
  });

  it('counts at dispatch, so a batch settled as silent cannot run past the limit', async () => {
    const h = harness({ searchProvider: true });
    // Every call of the batch was classified while the count was still low.
    h.host.web_search.silentSearches = SILENT_SEARCH_LIMIT - 1;
    const first = await runSearch(h, 'first');
    const second = await runSearch(h, 'second');
    expect(isCallToolResponseResult(first) && first.result.isError).not.toBe(true);
    expect(isApprovalRequiredResponse(second)).toBe(false);
    expect(isCallToolResponseResult(second) && second.result.isError).toBe(true);
    expect(h.dispatched.map(call => call.args)).toEqual([{ query: 'first' }]);
    expect(h.host.web_search.silentSearches).toBe(SILENT_SEARCH_LIMIT);
  });

  it('does not count a search the user approved', async () => {
    const h = harness({ searchProvider: true, searchWithoutAsking: false });
    await h.toolSet.callTool({ name: 'lookup', arguments: { query: 'approved' } }, { status: 'allow' });
    expect(h.dispatched).toHaveLength(1);
    expect(h.host.web_search.silentSearches).toBe(0);
    expect(h.audit).toEqual([]);
  });
});

describe('links', () => {
  const page = 'https://news.example.org/2024/06/oslo-weather';
  const results = (name: string): string =>
    name === 'lookup' ? JSON.stringify({ results: [{ title: 'Oslo', url: page }] }) : 'page body';

  async function fetchTier(h: Harness, url: string) {
    return h.toolSet.toolCallInfo({ name: 'read_page', arguments: { url } });
  }

  it('is silent only for a URL that a search result of this turn returned, exactly', async () => {
    const h = harness({ searchProvider: true, result: results });
    expect((await fetchTier(h, page)).tier).toBe(3);

    await runSearch(h, 'oslo weather');
    expect((await fetchTier(h, page)).tier).toBe(1);

    await h.toolSet.callTool({ name: 'read_page', arguments: { url: page } });

    expect(h.audit.map(row => row.description)).toEqual(['Searched: oslo weather', `Searched: ${page}`]);
  });

  it('asks for any modified or composed URL', async () => {
    const h = harness({ searchProvider: true, result: results });
    await runSearch(h, 'oslo weather');
    for (const url of [
      `${page}?x=1`,
      `${page}/`,
      page.replace('https', 'http'),
      page.replace('news.example.org', 'news.example.org.evil.test'),
      'https://other.example.org/page',
      'news.example.org/2024/06/oslo-weather',
      'news.example.org',
    ]) {
      expect((await fetchTier(h, url)).tier).toBe(3);
    }
  });

  it('asks for a search query that carries a link no result returned', async () => {
    const h = harness({ searchProvider: true, result: results });
    const info = await h.toolSet.toolCallInfo({
      name: 'lookup',
      arguments: { query: 'summarize https://evil.example/x' },
    });
    expect(info.tier).toBe(3);
  });

  it('denies a composed URL in a scheduled run', async () => {
    const h = harness({ searchProvider: true, result: results, unattended: true });
    await runSearch(h, 'oslo weather');
    const info = await fetchTier(h, `${page}?x=1`);
    expect(info.pre_dispatch_failure?.kind).toBe('policy_blocked');
  });

  it('remembers URLs only from the designated provider, and only for the turn that saw them', async () => {
    const other = harness({ searchProvider: false, serverName: 'other', result: results });
    await runSearch(other, 'oslo weather');
    expect(other.host.web_search.resultUrls.size).toBe(0);

    const first = harness({ searchProvider: true, result: results });
    await runSearch(first, 'oslo weather');
    const nextTurn = harness({ searchProvider: true, result: results });
    expect((await fetchTier(nextTurn, page)).tier).toBe(3);
  });

  it('does not widen the set from the page a fetch returned, so a crawl cannot chain itself', async () => {
    const linked = 'https://news.example.org/2024/06/related';
    const h = harness({
      searchProvider: true,
      result: name => (name === 'lookup' ? JSON.stringify({ url: page }) : `read more at ${linked}`),
    });
    await runSearch(h, 'oslo weather');
    await h.toolSet.callTool({ name: 'read_page', arguments: { url: page } });

    expect((await fetchTier(h, linked)).tier).toBe(3);
    expect((await fetchTier(h, page)).tier).toBe(1);
  });

  it('reads URLs out of prose and markdown results as well', async () => {
    const h = harness({
      searchProvider: true,
      result: () => `See [the report](${page}) or visit https://docs.example.net/guide.`,
    });
    await runSearch(h, 'oslo weather');
    expect((await fetchTier(h, page)).tier).toBe(1);
    expect((await fetchTier(h, 'https://docs.example.net/guide')).tier).toBe(1);
  });
});
