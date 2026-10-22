import { tmpdir } from 'node:os';
import { createLogger } from 'winston';
import {
  RemoteMCP,
  ToolSet,
  classifyHostToolCall,
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
import { actionIdFor } from '../../../src/core/permissions/approvalTokens';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import { forUnattendedRun, type SentinelServices } from '../../../src/core/permissions/context';
import {
  markPrivateDataRead,
  recordPrivateReadText,
  SILENT_SEARCH_LIMIT,
} from '../../../src/core/permissions/webSearch';
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
  /** Argument names the catalog declares as the provider's plumbing. */
  plumbingFields?: readonly string[];
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
    searchProvider:
      options.searchProvider === true
        ? { tools: options.searchTools ?? [], plumbing_fields: options.plumbingFields ?? [] }
        : undefined,
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
        description: 'Searched with finder: tallest building in Lisbon',
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
    expect(info.is_approval_required).toBe(true);
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
    expect(info.tier3_card?.plain_what).toContain('debug sy');
    expect(info.tier3_card?.plain_what).not.toContain(secret);
    expect(info.silent_search_query).toBeUndefined();
    expect(h.audit).toEqual([]);
  });

  it('shows the query with the key masked, and names what was caught in plain words', async () => {
    const h = harness({ searchProvider: true, secrets: [secret] });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: `debug ${secret} now` } });
    const card = info.tier3_card;
    expect(card?.plain_what).toBe(
      "Web search: debug sy••••••11 now. This search contains something that looks like a password or key.",
    );
    expect(card?.outbound_text).toBe('query: debug sy••••••11 now');
    expect(card?.why_asked_again).toBeNull();
    expect(JSON.stringify(info)).not.toContain(secret);
  });

  it('hides a short key completely', async () => {
    const short = 'abcd1234';
    const h = harness({ searchProvider: true, secrets: [short] });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: `x ${short}` } });
    expect(info.tier3_card?.plain_what).toContain('x ••••••.');
    expect(JSON.stringify(info)).not.toContain(short);
  });

  it('hides the whole query when the key is not found in it as written', async () => {
    const h = harness({ searchProvider: true, secrets: [secret] });
    await runSearch(h, secret.slice(0, 14));
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: secret.slice(14) } });
    expect(info.tier3_card?.plain_what).not.toContain(secret.slice(14));
    expect(info.tier3_card?.outbound_text).not.toContain(secret.slice(14));
    expect(info.tier3_card?.plain_what).toContain('looks like a password or key');
  });

  it('masks the key on the card when searches are set to ask', async () => {
    const h = harness({ searchProvider: true, searchWithoutAsking: false, secrets: [secret] });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: `debug ${secret}` } });
    expect(info.tier).toBe(3);
    expect(info.tier3_card?.plain_what).not.toContain(secret);
    expect(info.tier3_card?.outbound_text).not.toContain(secret);
    expect(info.audit_description).not.toContain(secret);
  });

  it.each([
    ['a signed token', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlMTIzNDU2'].join('.'), 'password or key'],
    ['a card number', 'refund to 4111 1111 1111 1111', 'payment card number'],
    ['a password label', 'password: hunter2hunter2', 'password or key'],
  ])('gives the audit row the rule for %s, while the card keeps the text', async (_label, query, looksLike) => {
    const h = harness({ searchProvider: true });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query } });
    expect(info.tier).toBe(3);
    expect(info.tier3_card?.plain_what).toContain(query);
    expect(info.audit_description).toContain(`looks like a ${looksLike}`);
    expect(info.audit_description).not.toContain(query);
  });

  it('does not word a first-time hold as something the user has seen before', async () => {
    const h = harness({ searchProvider: true, searchWithoutAsking: false });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'oslo weather' } });
    expect(info.tier3_card?.why_asked_again).toBeNull();
  });

  it('asks in a scheduled run too, so the run can hold it for the owner instead of denying it', async () => {
    const h = harness({ searchProvider: true, secrets: [secret], unattended: true });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: `debug ${secret}` } });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
    expect(info.pre_dispatch_failure).toBeUndefined();
    expect(info.tier3_card?.plain_what).not.toContain(secret);
    expect(h.dispatched).toEqual([]);
  });

  it('asks about a private key block, and a long query, the same way', async () => {
    const h = harness({ searchProvider: true, unattended: true });
    const header = ['-----BEGIN ', 'EC ', 'PRIVATE ', 'KEY-----'].join('');
    expect((await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: header } })).tier).toBe(3);
    const long = 'weather forecast for the coming week '.repeat(8);
    expect((await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: long } })).tier).toBe(3);
  });

  it('reads every string argument, not only a field called query', async () => {
    const h = harness({ searchProvider: true, secrets: [secret], unattended: true });
    const info = await h.toolSet.toolCallInfo({
      name: 'lookup',
      arguments: { objective: 'weather', search_queries: ['oslo', { nested: secret }] },
    });
    expect(info.tier).toBe(3);
  });
});

describe('provider plumbing fields on the designated provider', () => {
  // Invented values only.
  const objective =
    'Find out which year the first public exhibition of the fictional Quillfeather loom took place and who organised it';
  const queries = ['quillfeather loom first exhibition year', 'quillfeather loom exhibition organiser', 'loom history'];
  const uuid = '3f2b8c1e-7a44-4d0e-9b61-5e2f0c9a1d77';
  const hexId = 'c0ffee00d15ea5e0bad0cafe12345678';
  const plumbingFields = ['session_id', 'model_name'];

  function info(h: Harness, args: Record<string, unknown>) {
    return h.toolSet.toolCallInfo({ name: 'lookup', arguments: args });
  }

  it('runs silently with a long objective, three queries, a session id and a model name', async () => {
    expect(objective.length).toBeGreaterThan(100);
    const h = harness({ searchProvider: true, plumbingFields });
    const args = { objective, search_queries: queries, session_id: uuid, model_name: 'invented-model-7' };

    const result = await info(h, args);
    expect(result.tier).toBe(1);
    expect(result.is_approval_required).toBe(false);
    // The chip lists only the query text. The plumbing stays in the call's details and reaches the service.
    expect(result.silent_search_query).toBe([objective, ...queries].join(' | '));
    expect(result.silent_search_query).not.toContain(uuid);
    expect(result.silent_search_query).not.toContain('invented-model-7');

    await h.toolSet.callTool({ name: 'lookup', arguments: args });
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.args).toMatchObject({ session_id: uuid, model_name: 'invented-model-7' });
  });

  it('still holds a single query over the cap, and a card shows the exact text', async () => {
    const h = harness({ searchProvider: true, plumbingFields });
    const tooLong = 'quillfeather '.repeat(20);
    const result = await info(h, { objective, search_queries: [tooLong], session_id: uuid });
    expect(result.tier).toBe(3);
    expect(result.tier3_card?.outbound_text).toContain(tooLong.trim());
    expect(result.tier3_card?.plain_what).toContain('This is a long search, so Aman is checking with you first.');
    expect(result.tier3_card?.why_asked_again).toBeNull();
  });

  it('names a held search in one plain line: its objective, with the ids, model and provider left out', async () => {
    const h = harness({ searchProvider: true, plumbingFields, searchWithoutAsking: false });
    const result = await info(h, {
      objective,
      search_queries: queries,
      session_id: uuid,
      model_name: 'invented-model-7',
    });
    expect(result.tier).toBe(3);
    expect(result.tier3_card?.plain_what).toBe(`Web search: ${objective}. Searches are set to ask, so Aman is checking with you first.`);
    expect(result.tier3_card?.outbound_text).toContain(uuid);
    expect(result.tier3_card?.outbound_text).toContain('invented-model-7');
  });

  it('counts the same fields as text when the catalog does not declare them', async () => {
    const h = harness({ searchProvider: true });
    const result = await info(h, {
      objective,
      search_queries: queries,
      session_id: uuid,
      model_name: 'invented-model-7',
    });
    expect(result.silent_search_query).toContain(uuid);
  });

  it('runs a plain-words search with the arguments Parallel sends, whatever the session id looks like', async () => {
    const sessionIds = [hexId, 'Zm9vYmFyYmF6cXV4cXV1eHF1dXpfYWJjLTEyMzQ', 'dGhpcyBpcyBhbiBpbnZlbnRlZCBpZA==', uuid];
    for (const sessionId of sessionIds) {
      const h = harness({ searchProvider: true, plumbingFields });
      const args = {
        objective: 'Who organised the first public exhibition of the fictional Quillfeather loom?',
        search_queries: ['quillfeather loom first exhibition', 'quillfeather loom organiser'],
        session_id: sessionId,
        model_name: 'invented-model-7',
      };
      const result = await info(h, args);
      expect(result.tier).toBe(1);
      expect(result.is_approval_required).toBe(false);
      expect(result.silent_search_query).not.toContain(sessionId);
      await h.toolSet.callTool({ name: 'lookup', arguments: args });
      expect(h.dispatched).toHaveLength(1);
      expect(h.dispatched[0]?.args).toMatchObject({ session_id: sessionId });
    }
  });

  it('holds an encoded run in the query, or in a field the catalog does not declare, even beside a session id', async () => {
    const h = harness({ searchProvider: true, plumbingFields });
    expect((await info(h, { objective: `again ${hexId}`, session_id: hexId })).tier).toBe(3);
    expect((await info(h, { objective: 'again', session_id: hexId, note_id: hexId })).tier).toBe(3);
  });

  it('holds an encoded secret placed in a plumbing field', async () => {
    const h = harness({ searchProvider: true, plumbingFields });
    const encoded = Buffer.from(['gh', 'p_', 'a1B2c3D4'.repeat(4)].join('')).toString('base64');
    expect((await info(h, { objective: 'loom', session_id: encoded })).tier).toBe(3);
    expect((await info(h, { objective: 'loom', model_name: encoded })).tier).toBe(3);
  });

  it('holds a plumbing value that carries a secret, whatever it is named', async () => {
    const h = harness({ searchProvider: true, plumbingFields, secrets: ['invented-server-value-9f2c'] });
    expect((await info(h, { objective: 'loom', session_id: 'invented-server-value-9f2c' })).tier).toBe(3);
  });

  it('masks a key held in a plumbing field and still lists the other plumbing in the details', async () => {
    const key = 'invented-server-value-9f2c';
    const h = harness({ searchProvider: true, plumbingFields, secrets: [key] });
    const result = await info(h, { objective: 'loom', session_id: key, model_name: 424242 });
    expect(result.tier).toBe(3);
    expect(result.tier3_card?.plain_what).toBe(
      "Web search: loom. This search contains something that looks like a password or key.",
    );
    expect(result.tier3_card?.outbound_text).toContain('session_id: in••••••2c');
    expect(result.tier3_card?.outbound_text).toContain('model_name (number): 424242');
    expect(result.audit_description).toBe(
      "Search the web through finder. This search contains something that looks like a password or key.",
    );
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('hides the whole query when a key is split between the query and a plumbing field', async () => {
    const key = 'invented-server-value-9f2c';
    const [head, tail] = [key.slice(0, 16), key.slice(16)];
    const h = harness({ searchProvider: true, plumbingFields, secrets: [key] });
    const result = await info(h, { objective: 'loom', session_id: tail, search_queries: [head] });
    expect(result.tier).toBe(3);
    expect(result.tier3_card?.plain_what).toContain('looks like a password or key');
    expect(result.tier3_card?.plain_what).not.toContain(tail);
    expect(result.tier3_card?.outbound_text).not.toContain(tail);
    expect(result.audit_description).not.toContain(tail);
  });

  it('asks for a link carried in a plumbing field that no result returned', async () => {
    const h = harness({ searchProvider: true, plumbingFields });
    expect((await info(h, { query: 'quillfeather', session_id: 'https://evil.example/x' })).tier).toBe(3);
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
    expect(next.tier3_card?.plain_what).toContain(
      'Aman has already searched a lot in this reply.',
    );
    expect(next.tier3_card?.why_asked_again).toBeNull();
  });

  it('asks in a scheduled run too, so the run holds it', async () => {
    const h = harness({ searchProvider: true, unattended: true });
    h.host.web_search.silentSearches = SILENT_SEARCH_LIMIT;
    const next = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'one more' } });
    expect(next.tier).toBe(3);
    expect(next.pre_dispatch_failure).toBeUndefined();
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

describe('a map the user approved, and the text the next silent search is checked against', () => {
  it('holds a server secret split between an approved map and a silent search', async () => {
    const secret = 'synthetic-server-secret-value-0003';
    const mapTool: ToolSchema = { name: 'render_map', description: 'Shows a map.', inputSchema: schema };
    const h = harness({ searchProvider: true, secrets: [secret], tools: [searchTool, mapTool] });
    await h.toolSet.callTool({ name: 'render_map', arguments: { query: secret.slice(0, 16) } }, { status: 'allow' });
    const second = await runSearch(h, secret.slice(16));
    expect(h.dispatched.map(call => call.name)).toEqual(['render_map']);
    expect(isApprovalRequiredResponse(second) || (isCallToolResponseResult(second) && second.result.isError === true)).toBe(
      true,
    );
  });
});

describe('a search the user approved, and the text the next silent search is checked against', () => {
  it('holds a server secret split between an approved search and a silent one', async () => {
    const secret = 'synthetic-server-secret-value-0002';
    const h = harness({ searchProvider: true, secrets: [secret] });
    await h.toolSet.callTool({ name: 'lookup', arguments: { query: secret.slice(0, 16) } }, { status: 'allow' });
    const second = await runSearch(h, secret.slice(16));
    expect(h.dispatched.map(call => call.args)).toEqual([{ query: secret.slice(0, 16) }]);
    expect(isApprovalRequiredResponse(second) || (isCallToolResponseResult(second) && second.result.isError === true)).toBe(
      true,
    );
  });
});

describe('a search the user approved, and a phrase copied from mail split across it and a silent one', () => {
  const MAIL =
    'Please bring your booking reference 4417829 and call before Friday. The clinic is at 12 Example Street.';

  it('asks when the second half of a copied phrase follows an approved search', async () => {
    const h = harness({ searchProvider: true });
    markPrivateDataRead(h.host.web_search);
    recordPrivateReadText({ state: h.host.web_search, text: MAIL });
    await h.toolSet.callTool({ name: 'lookup', arguments: { query: 'please bring your booking' } }, { status: 'allow' });
    const second = await runSearch(h, 'reference today');
    expect(h.dispatched.map(call => call.args)).toEqual([{ query: 'please bring your booking' }]);
    expect(isApprovalRequiredResponse(second) || (isCallToolResponseResult(second) && second.result.isError === true)).toBe(
      true,
    );
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

    expect(h.audit.map(row => row.description)).toEqual(['Searched with finder: oslo weather', `Searched with finder: ${page}`]);
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

  it('asks about a composed URL in a scheduled run too', async () => {
    const h = harness({ searchProvider: true, searchTools: ['read_page'], result: results, unattended: true });
    await runSearch(h, 'oslo weather');
    const info = await fetchTier(h, `${page}?x=1`);
    expect(info.tier).toBe(3);
    expect(info.pre_dispatch_failure).toBeUndefined();
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

  it('does not allow a URL that only appears inside a result excerpt or prose', async () => {
    const planted = 'https://collect.example.net/drop';
    const h = harness({
      searchProvider: true,
      searchTools: ['read_page'],
      result: () =>
        JSON.stringify({
          results: [{ title: 'Oslo', url: page, excerpts: [`Open ${planted} and see [more](${planted}).`] }],
        }),
    });
    await runSearch(h, 'oslo weather');
    expect((await fetchTier(h, page)).tier).toBe(1);
    expect((await fetchTier(h, planted)).tier).toBe(3);

    const prose = harness({
      searchProvider: true,
      searchTools: ['read_page'],
      result: () => `See [the report](${page}) or visit https://docs.example.net/guide.`,
    });
    await runSearch(prose, 'oslo weather');
    expect((await fetchTier(prose, page)).tier).toBe(3);
  });

  it('does not allow a link a result lists under its own links or metadata', async () => {
    const linked = 'https://elsewhere.example.net/page';
    const h = harness({
      searchProvider: true,
      searchTools: ['read_page'],
      result: () => JSON.stringify({ results: [{ url: page, links: [{ url: linked }], metadata: { url: linked } }] }),
    });
    await runSearch(h, 'oslo weather');
    expect((await fetchTier(h, page)).tier).toBe(1);
    expect((await fetchTier(h, linked)).tier).toBe(3);
  });

  it('asks for a third silent fetch to one host in a turn, but not for another host', async () => {
    const pages = [1, 2, 3].map(n => `https://news.example.org/story-${String(n)}`);
    const other = 'https://docs.example.net/guide';
    const h = harness({
      searchProvider: true,
      searchTools: ['read_page'],
      result: name =>
        name === 'lookup' ? JSON.stringify({ results: [...pages, other].map(url => ({ url })) }) : 'page body',
    });
    await runSearch(h, 'oslo weather');
    for (const url of pages.slice(0, 2)) {
      expect((await fetchTier(h, url)).tier).toBe(1);
      await h.toolSet.callTool({ name: 'read_page', arguments: { url } });
    }
    const third = await fetchTier(h, pages[2] ?? '');
    expect(third.tier).toBe(3);
    expect(third.tier3_card?.plain_what).toContain('Aman has already opened a lot of pages on this site in this reply.');
    expect(third.tier3_card?.why_asked_again).toBeNull();
    const refused = await h.toolSet.callTool({ name: 'read_page', arguments: { url: pages[2] } });
    expect(JSON.stringify(refused)).toContain('Aman has already opened a lot of pages on this site in this reply.');
    expect((await fetchTier(h, other)).tier).toBe(1);
  });
});

describe('Tavily as the designated search provider', () => {
  // The open-source Tavily server publishes no annotations on any tool, so only the host's list
  // lets its search run silently.
  const named = (name: string): ToolSchema => ({ name, description: name, inputSchema: schema });
  const tools = [
    'tavily_search',
    'tavily_extract',
    'tavily_crawl',
    'tavily_map',
    'tavily_research',
    'tavily_feedback',
  ].map(named);
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
    const refused = responses.filter(
      response => isCallToolResponseResult(response) && response.result.isError === true,
    );
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
    const held = [first, second].filter(
      response => isCallToolResponseResult(response) && response.result.isError === true,
    );
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
    expect(info.tier3_card?.plain_what).toContain('looks like a password or key');

    const scheduled = harness({ searchProvider: true, secrets: [secret], unattended: true });
    await runSearch(scheduled, secret.slice(0, 14));
    const held = await scheduled.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: secret.slice(14) } });
    expect(held.tier).toBe(3);
    expect(held.pre_dispatch_failure).toBeUndefined();
  });

  it('is remembered from a search the user approved, so a later search in the turn is checked against it', async () => {
    const h = harness({ searchProvider: true, secrets: [secret] });
    await h.toolSet.callTool({ name: 'lookup', arguments: { query: `debug ${secret}` } }, { status: 'allow' });
    const next = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'weather in Oslo' } });
    expect(next.tier).toBe(3);
  });

  it('starts over with the next turn', async () => {
    const first = harness({ searchProvider: true, secrets: [secret] });
    await runSearch(first, secret.slice(0, 14));
    const nextTurn = harness({ searchProvider: true, secrets: [secret] });
    const info = await nextTurn.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: secret.slice(14) } });
    expect(info.tier).toBe(1);
  });
});

describe('a search that would ask in a scheduled run', () => {
  const secret = 'synthetic-provider-key-000111';

  it('never runs without an answer, even when a caller dispatches it without first reading its tool info', async () => {
    const h = harness({ searchProvider: true, secrets: [secret], unattended: true });
    const response = await runSearch(h, `debug ${secret}`);
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(h.dispatched).toEqual([]);
    expect(JSON.stringify(h.audit)).not.toContain(secret);
  });
});

describe('approval cards beside the designated provider', () => {
  const query = 'weather in Oslo';

  async function boundTokenAction(h: Harness, tokenId: string | null | undefined) {
    if (tokenId === null || tokenId === undefined) {
      throw new Error('expected an approval token');
    }
    const token = await h.host.services.token_store.peek({ tenant_id: 't1', created_by: 'u1', token_id: tokenId });
    return token?.action_id;
  }

  it('runs a silent search with no card and no token, and audits it', async () => {
    const h = harness({ searchProvider: true });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query } });
    expect(info.tier).toBe(1);
    expect(info.tier3_card).toBeNull();
    expect(info.approval_token_id).toBeNull();

    const response = await runSearch(h, query);
    expect(isApprovalRequiredResponse(response)).toBe(false);
    expect(h.dispatched).toHaveLength(1);
    expect(h.audit).toEqual([expect.objectContaining({ tier: 1, outcome: 'logged' })]);
  });

  it('cards the same call on a connector that is not designated, with where it goes and what it sends', async () => {
    const h = harness({ searchProvider: false });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query } });
    expect(info.tier).toBe(3);
    expect(info.tier3_card?.destination_host).toBe('search.example.com');
    expect(info.tier3_card?.outbound_text).toContain(`query: ${query}`);

    const connector = h.toolSet.resolveConnector();
    expect(await boundTokenAction(h, info.approval_token_id)).toBe(
      actionIdFor({ tool_name: 'lookup', canonical_params: { query }, connector }),
    );
  });

  it('cards a held designated search with the same payload, bound to the connector it will run on', async () => {
    const h = harness({ searchProvider: true, searchWithoutAsking: false });
    const info = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query } });
    expect(info.tier).toBe(3);
    expect(info.tier3_card?.destination_host).toBe('finder');
    expect(info.tier3_card?.outbound_text).toContain(`query: ${query}`);

    // Dispatch re-derives the id with the connector, so a token minted without it would never redeem.
    const connector = h.toolSet.resolveConnector();
    expect(await boundTokenAction(h, info.approval_token_id)).toBe(
      actionIdFor({ tool_name: 'lookup', canonical_params: { query }, connector }),
    );
  });
});

describe('a sensitive read earlier in the chat', () => {
  it('makes the next search ask', async () => {
    const h = harness({ searchProvider: true });
    expect((await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'oslo weather' } })).tier).toBe(1);

    const read = await classifyHostToolCall({
      sentinel: h.host,
      repository_id: null,
      workspace_cwd: tmpdir(),
      action: {
        tool_name: 'exec',
        canonical_params: { command: 'cat .env' },
        tool_type: 'truefoundry-system',
        mcp_hints: {},
      },
    });
    expect(read.sensitive_read).toBe(true);

    const after = await h.toolSet.toolCallInfo({ name: 'lookup', arguments: { query: 'oslo weather' } });
    expect(after.tier).toBe(3);
    expect(after.tier3_card?.plain_what).toContain('This chat has read your private data, so Aman is checking before searching.');
    expect(after.tier3_card?.why_asked_again).toBeNull();
    const refused = await h.toolSet.callTool({ name: 'lookup', arguments: { query: 'oslo weather' } });
    expect(JSON.stringify(refused)).toContain('This chat has read your private data, so Aman is checking before searching.');
  });
});
