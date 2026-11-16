import { createLogger } from 'winston';
import { RemoteMCP, ToolSet, createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ToolSchema } from '../../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger } from '../harnessMocks';

jest.mock('../../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../../src/core/mcp/remoteMcpClient')>(
    '../../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);
const schema = { type: 'object' as const, properties: {} };

/** A remote server that claims, in its own listing, that its tool runs without the network. */
const CLAIMING_TOOL: ToolSchema & { requires_network: boolean } = {
  name: 'lunar_lookup',
  description: 'Looks something up on the lunar archive.',
  inputSchema: schema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  requires_network: false,
};

function offlineHost() {
  return createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    services: { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), isOffline: () => Promise.resolve(true) },
  });
}

function remoteToolSet(sentinel: ReturnType<typeof offlineHost>): ToolSet {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: [CLAIMING_TOOL] }),
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
      close: () => Promise.resolve(),
    }),
  );
  return new ToolSet({
    source: new RemoteMCP({
      name: 'lunar',
      id: 'lunar',
      url: 'https://lunar.example/mcp',
      headers: {},
      logger: createLogger({ silent: true }),
      tracing: NOOP_AGENT_TRACING,
      requestTimeoutMs: 60_000,
      connectTimeoutMs: 5_000,
      signal: new AbortController().signal,
    }),
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [] },
    preload: true,
    sentinel,
  });
}

describe('a remote tool that claims it needs no network', () => {
  it('loses the claim when its tool list is read', async () => {
    const listed = await remoteToolSet(offlineHost()).listTools();
    if ('authRequired' in listed) {
      throw new Error('expected a tool list');
    }
    expect(listed.result.tools.map(tool => tool.name)).toEqual(['lunar_lookup']);
    expect(listed.result.tools[0]?.requires_network).toBeUndefined();
  });

  it('is withheld from the model while offline', async () => {
    const sentinel = offlineHost();
    const requests: Parameters<ILLM['create']>[0][] = [];
    const modelClient: ILLM = {
      create: jest.fn((request: Parameters<ILLM['create']>[0]) => {
        requests.push(request);
        return finalAnswerStream();
      }),
      createNonStream: jest.fn(),
    };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      sentinel,
      capabilities: [],
      definition: {
        modelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [remoteToolSet(sentinel)],
        iterationLimit: 10,
      },
      context: [{ role: 'user', content: 'Look up the lunar archive' }],
    });
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      void event;
    }
    const offered = (requests[0]?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.function.name] : []));
    expect(offered).not.toContain('lunar_lookup');
  });

  it('is blocked when a call reaches it while offline', async () => {
    const toolSet = remoteToolSet(offlineHost());
    const info = await toolSet.toolCallInfo({ name: 'lunar_lookup', arguments: {} });
    expect(info.requires_network).toBeUndefined();
    expect(info.tier_reason).toBe('auto_denied');
    expect(info.pre_dispatch_failure?.message).toBe('Auto-denied: offline mode is on.');
    expect(info.pre_dispatch_failure?.kind).toBe('policy_blocked');
  });
});
