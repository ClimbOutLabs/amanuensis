/**
 * The Tavily preset, once the user picks it as the search provider, is served by the one in-process
 * Tavily client instead of a remote MCP connection. The key comes from the connector's saved header.
 */
import { AgentSpecSchema } from '../../src/agent-session/schemas/agentSpec';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import { isCallToolResponseResult, type IToolSet } from '../../src/core/mcp/IMCPServer';
import type { RemoteMcpHeaders } from '../../src/core/mcp/RemoteMCP';
import { connectRemoteMcp } from '../../src/core/mcp/remoteMcpClient';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { searchResponse } from '../core/search/tavilyFixtures';
import { makeMockILLM, makeSilentLogger } from './testHelpers';

jest.mock('../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../src/core/mcp/remoteMcpClient')>(
    '../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);

interface Connection {
  url: string;
  headers: RemoteMcpHeaders;
  designated: boolean;
}

async function resolveTavily(connection: Connection): Promise<IToolSet> {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: [] }),
      callTool: () => Promise.resolve({ content: [] }),
      close: () => Promise.resolve(),
    }),
  );
  const resolver = new TurnResourceResolver({
    llm: () =>
      Promise.resolve({
        modelClient: makeMockILLM(),
        defaultModelParams: {},
        modelId: undefined,
        modelSupportsVision: false,
      }),
    mcp: () =>
      Promise.resolve({
        url: connection.url,
        headers: connection.headers,
        search_provider: connection.designated ? { tools: ['tavily_search', 'tavily_extract'] } : undefined,
      }),
    mcpRequestTimeoutMs: 1_000,
    mcpConnectTimeoutMs: 1_000,
    logger: makeSilentLogger(),
  });
  const { definition } = await resolver.resolveAgentDefinition({
    spec: AgentSpecSchema.parse({
      model: { name: 'test-provider/test-model' },
      instructions: 'test',
      mcp_servers: [{ name: 'tavily' }],
      config: {
        ask_user_questions: { enabled: false },
        dynamic_sub_agents: { enabled: false },
        generative_ui: { enabled: false },
        context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
      },
    }),
    signal: new AbortController().signal,
    tracing: NOOP_AGENT_TRACING,
    tenant_id: 'tenant-1',
    created_by: 'user-1',
    session_id: 'session-1',
  });
  const toolSet = definition.toolSets?.find(candidate => candidate.name === 'tavily');
  if (toolSet === undefined) {
    throw new Error('no tool set resolved for tavily');
  }
  return toolSet;
}

function seenRequests() {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return Promise.resolve(new Response(JSON.stringify(searchResponse)));
  });
  return seen;
}

const search = { name: 'tavily_search', arguments: { query: 'English speaking doctor Lisbon' } };

describe('Tavily as the designated search provider', () => {
  beforeEach(() => {
    mockConnect.mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serves the tools in process, sends the saved key, and never opens an MCP connection', async () => {
    const seen = seenRequests();
    const toolSet = await resolveTavily({
      url: 'https://mcp.tavily.com/mcp',
      headers: { Authorization: 'Bearer tvly-test-key-1' },
      designated: true,
    });
    const info = await toolSet.toolCallInfo(search);
    expect(info.tier).toBe(1);
    expect(isCallToolResponseResult(await toolSet.callTool(search))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.tavily.com/search');
    expect(seen[0]?.headers['authorization']).toBe('Bearer tvly-test-key-1');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('goes keyless when the key was never filled in', async () => {
    const seen = seenRequests();
    const toolSet = await resolveTavily({
      url: 'https://mcp.tavily.com/mcp',
      headers: { Authorization: 'Bearer YOUR_TAVILY_API_KEY' },
      designated: true,
    });
    await toolSet.callTool(search);
    expect(seen[0]?.headers['x-tavily-access-mode']).toBe('keyless');
    expect(seen[0]?.headers['authorization']).toBeUndefined();
  });

  it('reads a key that is resolved at connect time', async () => {
    const seen = seenRequests();
    const toolSet = await resolveTavily({
      url: 'https://mcp.tavily.com/mcp',
      headers: () => Promise.resolve({ headers: { authorization: 'Bearer tvly-test-key-2' } }),
      designated: true,
    });
    await toolSet.callTool(search);
    expect(seen[0]?.headers['authorization']).toBe('Bearer tvly-test-key-2');
  });

  it('leaves a Tavily connector the user did not pick as the provider on its ordinary MCP connection', async () => {
    const toolSet = await resolveTavily({
      url: 'https://mcp.tavily.com/mcp',
      headers: { Authorization: 'Bearer tvly-test-key-1' },
      designated: false,
    });
    await toolSet.listTools();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('does not treat another host as Tavily', async () => {
    const toolSet = await resolveTavily({
      url: 'https://mcp.tavily.com.attacker.example/mcp',
      headers: { Authorization: 'Bearer tvly-test-key-1' },
      designated: true,
    });
    await toolSet.listTools();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});
