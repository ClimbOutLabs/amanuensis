/**
 * Which connectors a turn treats as first-party is the host's call alone: it comes back from the
 * host's connection lookup, per server, and never from the agent spec or the tools themselves.
 */
import { AgentSpecSchema, type AgentSpec } from '../../src/agent-session/schemas/agentSpec';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import type { IToolSet } from '../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../src/core/mcp/remoteMcpClient';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeMockILLM, makeSilentLogger } from './testHelpers';

jest.mock('../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../src/core/mcp/remoteMcpClient')>(
    '../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);

const closedWorldRead = {
  name: 'lookup_note',
  description: 'Reads a note.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

function makeResolver(firstPartyServers: readonly string[]) {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: [closedWorldRead] }),
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
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
      Promise.resolve({ url: `https://${name}.example.com/mcp`, first_party: firstPartyServers.includes(name) }),
    mcpRequestTimeoutMs: 1_000,
    mcpConnectTimeoutMs: 1_000,
    logger: makeSilentLogger(),
  });
}

function makeSpec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'test-provider/test-model' },
    instructions: 'test',
    mcp_servers: [{ name: 'memory' }, { name: 'notes' }],
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

async function tierOf(toolSets: readonly IToolSet[], serverName: string): Promise<number | undefined> {
  const toolSet = toolSets.find(candidate => candidate.name === serverName);
  if (toolSet === undefined) {
    throw new Error(`no tool set resolved for ${serverName}`);
  }
  return (await toolSet.toolCallInfo({ name: 'lookup_note', arguments: {} })).tier;
}

describe('TurnResourceResolver first-party connectors', () => {
  beforeEach(() => {
    mockConnect.mockClear();
  });

  it('runs a closed-world read at Tier 1 only on the connectors the host reports as first-party', async () => {
    const toolSets = await resolveToolSets(makeResolver(['memory']));

    expect(await tierOf(toolSets, 'memory')).toBe(1);
    expect(await tierOf(toolSets, 'notes')).toBe(3);
  });

  it('treats every connector as user-added when the host reports none', async () => {
    const toolSets = await resolveToolSets(makeResolver([]));

    expect(await tierOf(toolSets, 'memory')).toBe(3);
    expect(await tierOf(toolSets, 'notes')).toBe(3);
  });

  it('connects a first-party connector without following redirects, and every other one as before', async () => {
    const toolSets = await resolveToolSets(makeResolver(['memory']));
    await tierOf(toolSets, 'memory');
    await tierOf(toolSets, 'notes');

    const refusesRedirects = new Map(mockConnect.mock.calls.map(([params]) => [params.url, params.refuseRedirects]));
    expect(refusesRedirects.get('https://memory.example.com/mcp')).toBe(true);
    expect(refusesRedirects.get('https://notes.example.com/mcp')).toBe(false);
  });

  it('keeps the marker when another thread of the same turn mounts the shared connection', async () => {
    const resolver = makeResolver(['memory']);
    await resolveToolSets(resolver);
    const second = await resolveToolSets(resolver);

    expect(await tierOf(second, 'memory')).toBe(1);
    expect(await tierOf(second, 'notes')).toBe(3);
  });
});
