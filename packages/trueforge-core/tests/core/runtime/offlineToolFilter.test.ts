import type { ILLM } from '../../../src/core/llm/ILLM';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

function toolSetNamed(input: { name: string; tool: string }): IToolSet {
  return makeMockIMCPServer({
    name: input.name,
    preload: true,
    tools: [{ name: input.tool, description: input.tool, inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
  });
}

async function offeredToolNames({ offline }: { offline: boolean }): Promise<string[]> {
  const requests: Parameters<ILLM['create']>[0][] = [];
  const create = jest.fn((request: Parameters<ILLM['create']>[0]) => {
    requests.push(request);
    return finalAnswerStream();
  });
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const sentinel = createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    services: {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(offline),
    },
  });
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    sentinel,
    capabilities: [
      {
        systemToolSets: [
          toolSetNamed({ name: 'maps', tool: 'render_map' }),
          toolSetNamed({ name: 'maps-route', tool: 'render_route' }),
          toolSetNamed({ name: 'local', tool: 'get_current_datetime' }),
        ],
      },
    ],
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [toolSetNamed({ name: 'search-provider', tool: 'search' })],
      iterationLimit: 10,
    },
    context: [{ role: 'user', content: 'Show me Paris on a map' }],
  });
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    void event;
  }
  const tools = requests[0]?.tools ?? [];
  return tools.flatMap(tool => (tool.type === 'function' ? [tool.function.name] : []));
}

describe('offline tool list', () => {
  it('offers the maps tool and third-party tools while online', async () => {
    const names = await offeredToolNames({ offline: false });
    expect(names).toContain('render_map');
    expect(names).toContain('render_route');
    expect(names).toContain('search');
  });

  it('withholds network tools while offline and keeps local ones', async () => {
    const names = await offeredToolNames({ offline: true });
    expect(names).not.toContain('render_map');
    expect(names).not.toContain('render_route');
    expect(names).not.toContain('search');
    expect(names).toContain('get_current_datetime');
  });
});
