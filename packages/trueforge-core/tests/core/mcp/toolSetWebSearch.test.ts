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
  /** The host's list of the designated connector's search tools. */
  searchTools?: readonly string[];
  unattended?: boolean;
  searchWithoutAsking?: boolean;
  secrets?: readonly string[];
  result?: (name: string) => string;
  requireApprovalForTools?: string[] | undefined;
  tools?: ToolSchema[];
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
      listTools: () =>
        Promise.resolve({ tools: options.tools ?? [searchTool, fetchTool, writingTool, destructiveTool] }),
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
    searchProvider: options.searchProvider === true ? { tools: options.searchTools ?? [] } : undefined,
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

  it('runs an unannotated tool only when the host lists it as a search tool', async () => {
    const listed = harness({ searchProvider: true, searchTools: ['read_page'] });
    const info = await listed.toolSet.toolCallInfo({ name: 'read_page', arguments: { query: 'weather in Oslo' } });
    expect(info.tier).toBe(1);
    // The default approval selectors would gate an unannotated tool; the host's list waives that.
    expect(info.is_approval_required).toBe(false);

    const unlisted = harness({ searchProvider: true });
    const held = await unlisted.toolSet.toolCallInfo({ name: 'read_page', arguments: { query: 'weather in Oslo' } });
    expect(held.tier).toBe(3);
    expect(held.is_approval_required).toBe(true);
    expect(isApprovalRequiredResponse(await unlisted.toolSet.callTool({ name: 'read_page', arguments: {} }))).toBe(
      true,
    );
    expect(unlisted.dispatched).toEqual([]);
  });

  it('still honors a selector that names the tool', async () => {
    const h = harness({ searchProvider: true, requireApprovalForTools: ['lookup'] });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'weather in Oslo' } });
    expect(info.tier).toBe(1);
    expect(info.is_approval_required).toBe(true);
  });

  it('never lowers a tool that declares itself destructive or not read-only, even when listed', async () => {
    const h = harness({ searchProvider: true, searchTools: ['annotate', 'lookup_and_log'] });
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
    const h = harness({ searchProvider: true, searchTools: ['read_page'], result: results });
    expect((await fetchTier(h, page)).tier).toBe(3);

    await runSearch(h, 'oslo weather');
    expect((await fetchTier(h, page)).tier).toBe(1);

    await h.toolSet.callTool({ name: 'read_page', arguments: { url: page } });

    expect(h.audit.map(row => row.description)).toEqual(['Searched: oslo weather', `Searched: ${page}`]);
  });

  it('asks for any modified or composed URL', async () => {
    const h = harness({ searchProvider: true, searchTools: ['read_page'], result: results });
    await runSearch(h, 'oslo weather');
    for (const url of [
      `${page}?x=1`,
      `${page}/`,
      page.replace('https', 'http'),
      page.replace('news.example.org', 'news.example.org.evil.test'),
      'https://other.example.org/page',
      'news.example.org/2024/06/oslo-weather',
      'news.example.org',
      // Spellings that reach the same page but are not the string the result returned.
      page.replace('https://news.example.org', 'HTTPS://NEWS.EXAMPLE.ORG'),
      `${page}#top`,
      page.replace('oslo', 'os%6Co'),
      page.replace('//news.example.org', '//news.example.org:443'),
      page.replace('//news.example.org', '//news.example.org@evil.test'),
      page.replace('//news.example.org', '//evil.test\\@news.example.org'),
      `${page}\u200B`,
    ]) {
      expect((await fetchTier(h, url)).tier).toBe(3);
    }
  });

  it('asks for a search query that carries a link no result returned', async () => {
    const h = harness({ searchProvider: true, searchTools: ['read_page'], result: results });
    const info = await h.toolSet.toolCallInfo({
      name: 'lookup',
      arguments: { query: 'summarize https://evil.example/x' },
    });
    expect(info.tier).toBe(3);
  });

  it('denies a composed URL in a scheduled run', async () => {
    const h = harness({ searchProvider: true, searchTools: ['read_page'], result: results, unattended: true });
    await runSearch(h, 'oslo weather');
    const info = await fetchTier(h, `${page}?x=1`);
    expect(info.pre_dispatch_failure?.kind).toBe('policy_blocked');
  });

  it('remembers URLs only from the designated provider, and only for the turn that saw them', async () => {
    const other = harness({ searchProvider: false, serverName: 'other', result: results });
    await runSearch(other, 'oslo weather');
    expect(other.host.web_search.resultUrls.size).toBe(0);

    const first = harness({ searchProvider: true, searchTools: ['read_page'], result: results });
    await runSearch(first, 'oslo weather');
    const nextTurn = harness({ searchProvider: true, searchTools: ['read_page'], result: results });
    expect((await fetchTier(nextTurn, page)).tier).toBe(3);
  });

  it('does not widen the set from the page a fetch returned, so a crawl cannot chain itself', async () => {
    const linked = 'https://news.example.org/2024/06/related';
    const h = harness({
      searchProvider: true,
      searchTools: ['read_page'],
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
      searchTools: ['read_page'],
      result: () => `See [the report](${page}) or visit https://docs.example.net/guide.`,
    });
    await runSearch(h, 'oslo weather');
    expect((await fetchTier(h, page)).tier).toBe(1);
    expect((await fetchTier(h, 'https://docs.example.net/guide')).tier).toBe(1);
  });
});

describe('Tavily as the designated search provider', () => {
  // The open-source Tavily server publishes no annotations on any tool, so only the host's list
  // lets its search run silently.
  const named = (name: string): ToolSchema => ({ name, description: name, inputSchema: schema });
  const tools = ['tavily_search', 'tavily_extract', 'tavily_crawl', 'tavily_map', 'tavily_research', 'tavily_feedback'].map(
    named,
  );
  const searchTools = ['tavily_search', 'tavily_extract'];
  const page = 'https://docs.example.net/guides/oslo';
  const results = (name: string): string =>
    name === 'tavily_search' ? JSON.stringify({ results: [{ title: 'Oslo', url: page }] }) : 'page body';

  it('runs tavily_search silently behind the guard, and holds a query that carries a key', async () => {
    const h = harness({ serverName: 'tavily', searchProvider: true, searchTools, tools, result: results });
    const silent = await h.toolSet.toolCallInfo({ name: 'tavily_search', arguments: { query: 'oslo weather' } });
    expect(silent.tier).toBe(1);
    expect(silent.is_approval_required).toBe(false);
    expect(silent.silent_search_query).toBe('oslo weather');

    const key = ['AKI', 'A', 'ABCDEFGH', 'IJKLMNOP'].join('');
    const held = await h.toolSet.toolCallInfo({ name: 'tavily_search', arguments: { query: key } });
    expect(held.tier).toBe(3);
    expect(held.is_approval_required).toBe(true);
  });

  it('runs tavily_extract silently only on an exact URL this turn’s results returned', async () => {
    const h = harness({ serverName: 'tavily', searchProvider: true, searchTools, tools, result: results });
    const extract = (urls: string[]) => h.toolSet.toolCallInfo({ name: 'tavily_extract', arguments: { urls } });

    expect((await extract([page])).tier).toBe(3);
    await h.toolSet.callTool({ name: 'tavily_search', arguments: { query: 'oslo guide' } });
    expect((await extract([page])).tier).toBe(1);
    expect((await extract([`${page}?utm=1`])).tier).toBe(3);
    expect((await extract([page, 'https://evil.example/collect'])).tier).toBe(3);
  });

  it('keeps asking for the Tavily tools its preset does not list', async () => {
    const h = harness({ serverName: 'tavily', searchProvider: true, searchTools, tools, result: results });
    for (const name of ['tavily_crawl', 'tavily_map', 'tavily_research', 'tavily_feedback']) {
      const info = await h.toolSet.toolCallInfo({ name, arguments: { query: 'oslo' } });
      expect(info.tier).toBe(3);
      expect(info.is_approval_required).toBe(true);
    }
  });

  it('asks for the same tools when Tavily does not hold the role', async () => {
    const h = harness({ serverName: 'tavily', searchProvider: false, searchTools, tools, result: results });
    expect((await h.toolSet.toolCallInfo({ name: 'tavily_search', arguments: { query: 'oslo' } })).tier).toBe(3);
  });
});

describe('a write-capable connector designated as the search provider', () => {
  const named = (name: string, annotations?: ToolSchema['annotations']): ToolSchema => ({
    name,
    description: name,
    inputSchema: schema,
    ...(annotations === undefined ? {} : { annotations }),
  });
  // A GitHub-shaped server: some tools say they only read, the rest say nothing or say they write.
  const tools = [
    named('get_file_contents', { readOnlyHint: true }),
    named('search_code', { readOnlyHint: true }),
    named('create_issue'),
    named('add_issue_comment'),
    named('merge_pull_request'),
    named('push_files'),
    named('create_or_update_file', { readOnlyHint: false }),
    named('fork_repository', { readOnlyHint: false, destructiveHint: false }),
    named('run_workflow', { destructiveHint: true }),
  ];

  it('runs only the tools the server declares read-only without asking', async () => {
    const h = harness({ serverName: 'github', searchProvider: true, tools });
    for (const name of ['get_file_contents', 'search_code']) {
      const info = await h.toolSet.toolCallInfo({ name, arguments: { query: 'oslo' } });
      expect(info.tier).toBe(1);
      expect(info.is_approval_required).toBe(false);
    }
  });

  it('keeps every unannotated or write tool on the normal approval path', async () => {
    const h = harness({ serverName: 'github', searchProvider: true, tools });
    for (const name of [
      'create_issue',
      'add_issue_comment',
      'merge_pull_request',
      'push_files',
      'create_or_update_file',
      'fork_repository',
      'run_workflow',
    ]) {
      const info = await h.toolSet.toolCallInfo({ name, arguments: { query: 'oslo' } });
      expect(info.tier).toBe(3);
      expect(info.is_approval_required).toBe(true);
      expect(info.silent_search_query).toBeUndefined();
      const response = await h.toolSet.callTool({ name, arguments: { query: 'oslo' } });
      expect(isApprovalRequiredResponse(response)).toBe(true);
    }
    expect(h.dispatched).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('does not let a server claim read-only on a tool whose name says it writes or deletes', async () => {
    const h = harness({
      serverName: 'github',
      searchProvider: true,
      tools: [named('delete_branch', { readOnlyHint: true }), named('install_app', { readOnlyHint: true })],
    });
    expect((await h.toolSet.toolCallInfo({ name: 'delete_branch', arguments: { ref: 'main' } })).tier).toBe(3);
    expect((await h.toolSet.toolCallInfo({ name: 'install_app', arguments: { app: 'x' } })).tier).toBe(3);
  });
});

describe('explicit approval selectors on the designated provider', () => {
  const unannotated = (name: string): ToolSchema => ({ name, description: name, inputSchema: schema });
  const tools = [unannotated('find'), searchTool];

  async function approvalFor(requireApprovalForTools: string[] | undefined, name: string): Promise<boolean> {
    const h = harness({ searchProvider: true, searchTools: ['find'], tools, requireApprovalForTools });
    const info = await h.toolSet.toolCallInfo({ name, arguments: { query: 'oslo' } });
    expect(info.tier).toBe(1);
    return info.is_approval_required === true;
  }

  it('waives only the default list’s gate on missing annotations for a listed tool', async () => {
    expect(await approvalFor(undefined, 'find')).toBe(false);
    expect(await approvalFor(['@write', '@destructive', '@unclassified'], 'find')).toBe(false);
  });

  it('gates when the user changed the list in any way that still names the tool or its class', async () => {
    expect(await approvalFor(['@all'], 'find')).toBe(true);
    expect(await approvalFor(['@all'], 'lookup')).toBe(true);
    expect(await approvalFor(['find'], 'find')).toBe(true);
    expect(await approvalFor(['@unclassified'], 'find')).toBe(true);
    expect(await approvalFor(['@write', '@destructive', '@unclassified', 'lookup'], 'lookup')).toBe(true);
  });

  it('runs a listed tool when the user turned the selectors off or narrowed them past it', async () => {
    expect(await approvalFor([], 'find')).toBe(false);
    expect(await approvalFor(['@destructive'], 'find')).toBe(false);
  });
});

describe('admission of a batch of searches', () => {
  it('runs exactly the allowance when the whole batch is dispatched at once', async () => {
    const h = harness({ searchProvider: true });
    const responses = await Promise.all(
      Array.from({ length: SILENT_SEARCH_LIMIT + 5 }, (_, i) => runSearch(h, `topic ${String(i)}`)),
    );
    expect(h.dispatched).toHaveLength(SILENT_SEARCH_LIMIT);
    expect(h.host.web_search.silentSearches).toBe(SILENT_SEARCH_LIMIT);
    const refused = responses.filter(response => isCallToolResponseResult(response) && response.result.isError === true);
    expect(refused).toHaveLength(5);
    expect(h.audit).toHaveLength(SILENT_SEARCH_LIMIT);
    const text = JSON.stringify(refused[0]);
    expect(text).toContain('not run');
    expect(text).toContain('sent for approval');
  });

  it('tells a scheduled run to continue without the search rather than to ask', async () => {
    const h = harness({ searchProvider: true, unattended: true });
    h.host.web_search.silentSearches = SILENT_SEARCH_LIMIT;
    const response = await runSearch(h, 'one more');
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(h.dispatched).toEqual([]);
  });

  it('sees a key split between two searches of one batch', async () => {
    const h = harness({ searchProvider: true });
    const key = ['AKI', 'A', 'ABCDEFGH', 'IJKLMNOP'].join('');
    const [first, second] = await Promise.all([runSearch(h, key.slice(0, 9)), runSearch(h, key.slice(9))]);
    // Which of the two went first is up to the connection, so only that one of them was held matters.
    const held = [first, second].filter(response => isCallToolResponseResult(response) && response.result.isError === true);
    expect(held).toHaveLength(1);
    expect(h.dispatched).toHaveLength(1);
  });
});

describe('a secret sent in pieces over several searches', () => {
  const secret = 'synthetic-provider-key-000111';

  it('is held on the search that completes it, in a chat and in a scheduled run', async () => {
    const chat = harness({ searchProvider: true, secrets: [secret] });
    await runSearch(chat, secret.slice(0, 14));
    const info = await chat.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: secret.slice(14) } });
    expect(info.tier).toBe(3);
    expect(info.tier3_card?.why_asked_again).toContain('secret this server holds');

    const scheduled = harness({ searchProvider: true, secrets: [secret], unattended: true });
    await runSearch(scheduled, secret.slice(0, 14));
    const denied = await scheduled.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: secret.slice(14) } });
    expect(denied.pre_dispatch_failure?.kind).toBe('policy_blocked');
  });

  it('is not remembered from a search the user approved, so one approval does not hold the rest of the turn', async () => {
    const h = harness({ searchProvider: true, secrets: [secret] });
    await h.toolSet.callTool({ name: 'lookup', arguments: { query: `debug ${secret}` } }, { status: 'allow' });
    const next = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'weather in Oslo' } });
    expect(next.tier).toBe(1);
  });

  it('starts over with the next turn', async () => {
    const first = harness({ searchProvider: true, secrets: [secret] });
    await runSearch(first, secret.slice(0, 14));
    const nextTurn = harness({ searchProvider: true, secrets: [secret] });
    const info = await nextTurn.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: secret.slice(14) } });
    expect(info.tier).toBe(1);
  });
});

describe('a call the host auto-denied', () => {
  const secret = 'synthetic-provider-key-000111';

  it('never runs, even when a caller dispatches it without first reading its tool info', async () => {
    const h = harness({ searchProvider: true, secrets: [secret], unattended: true });
    const response = await runSearch(h, `debug ${secret}`);
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(h.dispatched).toEqual([]);
    expect(h.audit.every(row => row.outcome === 'auto_denied')).toBe(true);
    expect(JSON.stringify(h.audit)).not.toContain(secret);
  });
});
