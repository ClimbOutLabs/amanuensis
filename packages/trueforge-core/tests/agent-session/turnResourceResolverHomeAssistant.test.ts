/**
 * A Home Assistant connector saved before change tools were stored on its record holds no
 * declaration. The turn captures it from the server's own tool list and hands it to the host to
 * store, so the person's standing grants cover the server's declared change tools again.
 */
import { AgentSpecSchema, type AgentSpec } from '../../src/agent-session/schemas/agentSpec';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import type { IToolSet } from '../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../src/core/mcp/remoteMcpClient';
import { defaultSentinelServices, type SentinelServices } from '../../src/core/permissions/context';
import { TOOL_GRANT_REASON } from '../../src/core/permissions/toolGrants';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeMockILLM, makeSilentLogger } from './testHelpers';

jest.mock('../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../src/core/mcp/remoteMcpClient')>(
    '../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);
const HA_URL = 'https://homeassistant.example/mcp_server/sse';
const schema = { type: 'object' as const, properties: {} };

/** An invented change tool the server itself marks as changing things, and one it leaves unmarked. */
const HA_TOOLS = [
  { name: 'HassGlowLamp', description: 'Turns a lamp on.', inputSchema: schema, annotations: { readOnlyHint: false } },
  { name: 'HassHumLamp', description: 'Makes a lamp hum.', inputSchema: schema },
];

interface Stored {
  name: string;
  url: string;
  declared_change_tools: readonly string[];
}

function makeResolver(input: { declared_change_tools: readonly string[] | undefined; stored: Stored[] }) {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: HA_TOOLS }),
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
    mcp: () => Promise.resolve({ url: HA_URL, declared_change_tools: input.declared_change_tools }),
    storeDeclaredChangeTools: declaration => {
      input.stored.push(declaration);
      return Promise.resolve();
    },
    mcpRequestTimeoutMs: 1_000,
    mcpConnectTimeoutMs: 1_000,
    logger: makeSilentLogger(),
  });
}

function makeSpec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'test-provider/test-model' },
    instructions: 'test',
    mcp_servers: [{ name: 'home-assistant' }],
    config: {
      ask_user_questions: { enabled: false },
      dynamic_sub_agents: { enabled: false },
      generative_ui: { enabled: false },
      context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
    },
  });
}

async function servicesWithLightGrant(): Promise<SentinelServices> {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  await services.tool_grants.recordToolGrant({
    tenant_id: 'tenant-1',
    created_by: 'user-1',
    mcp_server_name: 'home-assistant',
    tool_name: 'ha:domain:light',
    connector_binding: null,
  });
  return services;
}

async function homeAssistantToolSet(resolver: TurnResourceResolver): Promise<IToolSet> {
  const { definition } = await resolver.resolveAgentDefinition({
    spec: makeSpec(),
    signal: new AbortController().signal,
    tracing: NOOP_AGENT_TRACING,
    tenant_id: 'tenant-1',
    created_by: 'user-1',
    session_id: 'session-1',
    sentinel_services: await servicesWithLightGrant(),
  });
  const toolSet = definition.toolSets?.find(candidate => candidate.name === 'home-assistant');
  if (toolSet === undefined) {
    throw new Error('no Home Assistant tool set resolved');
  }
  return toolSet;
}

describe('TurnResourceResolver Home Assistant change tools', () => {
  beforeEach(() => {
    mockConnect.mockClear();
  });

  it('captures the declaration for a record that holds none, and hands it to the host to store', async () => {
    const stored: Stored[] = [];
    await homeAssistantToolSet(makeResolver({ declared_change_tools: undefined, stored }));
    expect(stored).toEqual([{ name: 'home-assistant', url: HA_URL, declared_change_tools: ['HassGlowLamp'] }]);
  });

  it('lets a standing grant cover a declared change tool again once the declaration is captured', async () => {
    const toolSet = await homeAssistantToolSet(makeResolver({ declared_change_tools: undefined, stored: [] }));
    const glow = await toolSet.toolCallInfo({ name: 'HassGlowLamp', arguments: { entity_id: 'light.kitchen' } });
    expect(glow.tier).toBe(1);
    expect(glow.tier_reason).toBe(TOOL_GRANT_REASON);
    const hum = await toolSet.toolCallInfo({ name: 'HassHumLamp', arguments: { entity_id: 'light.kitchen' } });
    expect(hum.tier).toBe(3);
  });

  it('leaves a stored declaration as it is, and reads nothing to replace it', async () => {
    const stored: Stored[] = [];
    const toolSet = await homeAssistantToolSet(makeResolver({ declared_change_tools: [], stored }));
    expect(stored).toEqual([]);
    const glow = await toolSet.toolCallInfo({ name: 'HassGlowLamp', arguments: { entity_id: 'light.kitchen' } });
    expect(glow.tier).toBe(3);
  });
});
