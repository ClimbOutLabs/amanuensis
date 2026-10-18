/**
 * Which connector is the user's search provider is the host's call alone: it comes back from the
 * host's connection lookup, per server, and never from the agent spec or the tools themselves.
 */
import { AgentSpecSchema, type AgentSpec } from '../../src/agent-session/schemas/agentSpec';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import type { IToolSet } from '../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../src/core/mcp/remoteMcpClient';
import { SILENT_SEARCH_LIMIT } from '../../src/core/permissions/webSearch';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeMockILLM, makeSilentLogger } from './testHelpers';

jest.mock('../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../src/core/mcp/remoteMcpClient')>(
    '../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);

const searchTool = {
  name: 'lookup',
  description: 'Looks things up on the web.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

const unannotatedTool = {
  name: 'fetch_page',
  description: 'Reads a page.',
  inputSchema: { type: 'object' as const, properties: {} },
};

/** `searchProviders` maps each connector the host designates to the host's list of its search tools. */
function makeResolver(searchProviders: Readonly<Record<string, readonly string[]>>) {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: [searchTool, unannotatedTool] }),
      callTool: () =>
        Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://results.example.org/oslo' }] }) }],
        }),
      close: () => Promise.resolve(),
    }),
  );
  return new TurnResourceResolver({
    llm: () =>
      Promise.resolve({
        modelClient: makeMockILLM(),
        defaultModelParams: {},
        modelId: undefined,
        modelSupportsVision: false,
      }),
    mcp: name =>
      Promise.resolve({
        url: `https://${name}.example.com/mcp`,
        search_provider:
          name in searchProviders ? { tools: searchProviders[name] ?? [], plumbing_fields: [] } : undefined,
      }),
    mcpRequestTimeoutMs: 1_000,
    mcpConnectTimeoutMs: 1_000,
    logger: makeSilentLogger(),
  });
}

function makeSpec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'test-provider/test-model' },
    instructions: 'test',
    mcp_servers: [{ name: 'finder' }, { name: 'other' }],
    config: {
      ask_user_questions: { enabled: false },
      dynamic_sub_agents: { enabled: false },
      generative_ui: { enabled: false },
      context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
    },
  });
}

async function resolveToolSets(resolver: TurnResourceResolver): Promise<readonly IToolSet[]> {
  const { definition } = await resolver.resolveAgentDefinition({
    spec: makeSpec(),
    signal: new AbortController().signal,
    tracing: NOOP_AGENT_TRACING,
    tenant_id: 'tenant-1',
    created_by: 'user-1',
    session_id: 'session-1',
  });
  return definition.toolSets ?? [];
}

function toolSetNamed(toolSets: readonly IToolSet[], name: string): IToolSet {
  const toolSet = toolSets.find(candidate => candidate.name === name);
  if (toolSet === undefined) {
    throw new Error(`no tool set resolved for ${name}`);
  }
  return toolSet;
}

describe('TurnResourceResolver search provider', () => {
  beforeEach(() => {
    mockConnect.mockClear();
  });

  it('runs a search silently only on the connector the host reports as the search provider', async () => {
    const toolSets = await resolveToolSets(makeResolver({ finder: [] }));

    const finder = await toolSetNamed(toolSets, 'finder').toolCallInfo({
      name: 'lookup',
      arguments: { query: 'oslo' },
    });
    const other = await toolSetNamed(toolSets, 'other').toolCallInfo({ name: 'lookup', arguments: { query: 'oslo' } });
    expect(finder.tier).toBe(1);
    expect(finder.silent_search_query).toBe('oslo');
    expect(other.tier).toBe(3);
  });

  it('runs a tool without annotations silently only when the host’s list for the provider names it', async () => {
    const unlisted = toolSetNamed(await resolveToolSets(makeResolver({ finder: [] })), 'finder');
    const held = await unlisted.toolCallInfo({ name: 'fetch_page', arguments: { query: 'oslo' } });
    expect(held.tier).toBe(3);

    const listed = toolSetNamed(await resolveToolSets(makeResolver({ finder: ['fetch_page'] })), 'finder');
    const silent = await listed.toolCallInfo({ name: 'fetch_page', arguments: { query: 'oslo' } });
    expect(silent.tier).toBe(1);

    // A list the host holds for one connector never reaches another.
    const other = toolSetNamed(await resolveToolSets(makeResolver({ finder: ['fetch_page'] })), 'other');
    expect((await other.toolCallInfo({ name: 'fetch_page', arguments: { query: 'oslo' } })).tier).toBe(3);
  });

  it('treats every connector as an ordinary one when the host reports no provider', async () => {
    const toolSets = await resolveToolSets(makeResolver({}));
    const finder = await toolSetNamed(toolSets, 'finder').toolCallInfo({
      name: 'lookup',
      arguments: { query: 'oslo' },
    });
    expect(finder.tier).toBe(3);
  });

  it('connects the provider without following redirects', async () => {
    const toolSets = await resolveToolSets(makeResolver({ finder: [] }));
    await toolSetNamed(toolSets, 'finder').toolCallInfo({ name: 'lookup', arguments: { query: 'oslo' } });
    await toolSetNamed(toolSets, 'other').toolCallInfo({ name: 'lookup', arguments: { query: 'oslo' } });
    const refusesRedirects = new Map(mockConnect.mock.calls.map(([params]) => [params.url, params.refuseRedirects]));
    expect(refusesRedirects.get('https://finder.example.com/mcp')).toBe(true);
    expect(refusesRedirects.get('https://other.example.com/mcp')).toBe(false);
  });

  it('shares one search state across every thread of the turn, and gives the next turn its own', async () => {
    const resolver = makeResolver({ finder: [] });
    const first = await resolveToolSets(resolver);
    const second = await resolveToolSets(resolver);
    await toolSetNamed(first, 'finder').callTool({ name: 'lookup', arguments: { query: 'oslo' } });

    // A sub-agent thread of the same turn sees the link the root thread's search returned.
    const sameTurn = await toolSetNamed(second, 'finder').toolCallInfo({
      name: 'lookup',
      arguments: { query: 'https://results.example.org/oslo' },
    });
    expect(sameTurn.tier).toBe(1);

    const nextTurn = await resolveToolSets(makeResolver({ finder: [] }));
    const fresh = await toolSetNamed(nextTurn, 'finder').toolCallInfo({
      name: 'lookup',
      arguments: { query: 'https://results.example.org/oslo' },
    });
    expect(fresh.tier).toBe(3);
  });

  it('gives a resumed turn a fresh allowance, so only a person’s approval of something else extends a run', async () => {
    const turn = toolSetNamed(await resolveToolSets(makeResolver({ finder: [] })), 'finder');
    for (let i = 0; i < SILENT_SEARCH_LIMIT; i += 1) {
      await turn.callTool({ name: 'lookup', arguments: { query: `topic ${String(i)}` } });
    }
    const over = await turn.toolCallInfo({ name: 'lookup', arguments: { query: 'one more' } });
    expect(over.tier).toBe(3);

    // An approval resumes the conversation as a new turn, which builds a new resolver.
    const resumed = toolSetNamed(await resolveToolSets(makeResolver({ finder: [] })), 'finder');
    expect((await resumed.toolCallInfo({ name: 'lookup', arguments: { query: 'one more' } })).tier).toBe(1);
  });
});
