import { McpConnectionError } from '../../../src/core/errors';
import { convertMCPServersToTools } from '../../../src/core/mcp/convertMCPServers';
import type {
  AgentToolSchema,
  CallToolResolvedResponse,
  ListToolsResolvedResponse,
  ToolSource,
} from '../../../src/core/mcp/IMCPServer';
import { MCP_AUTO_PRELOAD_MAX_TOOLS } from '../../../src/core/mcp/toolSelectors';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import '../harnessMocks';
import { makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

const DEFAULT_SELECTORS = { enableTools: ['@all'], disableTools: [], preloadTools: [] };

function makeToolNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `tool_${i}`);
}

/** Fake policy-free source: N tools by default, or one that always rejects. */
function makeFakeSource(params: { name: string; toolCount?: number; failure?: Error }): ToolSource {
  const tools: AgentToolSchema[] = makeToolNames(params.toolCount ?? 2).map(name => ({
    name,
    description: `does ${name}`,
    inputSchema: OBJECT_INPUT_SCHEMA,
    // ToolSet's ToolSelectorPolicy overwrites this per-tool `preload` on every listTools() call
    // (filterAndAnnotate); the raw source-level value here is never read.
    preload: false,
  }));
  return {
    name: params.name,
    id: params.name,
    listTools: jest.fn((): Promise<ListToolsResolvedResponse> => {
      if (params.failure) {
        return Promise.reject(params.failure);
      }
      return Promise.resolve({ result: { tools }, wasInitialized: undefined });
    }),
    callTool: jest.fn((): Promise<CallToolResolvedResponse> =>
      Promise.resolve({
        result: { content: [{ type: 'text', text: 'ok' }] },
        wasInitialized: undefined,
        verificationReceiptCandidate: undefined,
      }),
    ),
    toolCallInfo: jest.fn(() =>
      Promise.resolve({
        type: 'mcp' as const,
        original_tool_name: 'tool_0',
        mcp_server_id: params.name,
        mcp_server_name: params.name,
        is_approval_required: false,
      }),
    ),
  };
}

describe('MCP auto-preload', () => {
  it('preloads a small server (<= MCP_AUTO_PRELOAD_MAX_TOOLS) left unset in the spec, no meta-tool round trip needed', async () => {
    const source = makeFakeSource({ name: 'small', toolCount: 2 });
    const toolSet = new ToolSet({ source, selectors: DEFAULT_SELECTORS, preload: undefined });

    const { convertedTools } = await convertMCPServersToTools({ tfyManagedServers: [], userServers: [toolSet] });

    // Both tools are registered directly in the model's tool list at the first call.
    expect(convertedTools.tools.map(t => (t.type === 'function' ? t.function.name : undefined))).toEqual(
      expect.arrayContaining(['tool_0', 'tool_1']),
    );
    expect(convertedTools.tools).toHaveLength(2);
    expect(toolSet.preload).toBe(true);
    // list_tools was never needed: the fake's listTools() is only the initialise probe itself.
    expect(source.listTools).toHaveBeenCalledTimes(1);
  });

  it('stays deferred for a server with more than MCP_AUTO_PRELOAD_MAX_TOOLS tools', async () => {
    const toolCount = MCP_AUTO_PRELOAD_MAX_TOOLS + 12; // 20 when the constant is 8
    const source = makeFakeSource({ name: 'large', toolCount });
    const toolSet = new ToolSet({ source, selectors: DEFAULT_SELECTORS, preload: undefined });

    const { convertedTools } = await convertMCPServersToTools({ tfyManagedServers: [], userServers: [toolSet] });

    expect(convertedTools.tools).toHaveLength(0);
    expect(toolSet.preload).toBe(false);
    expect(toolSet.hasPreloadedTools).toBe(false);
  });

  it('honors an explicit preload: false even for a server with few tools', async () => {
    const source = makeFakeSource({ name: 'explicit-deferred', toolCount: 2 });
    const toolSet = new ToolSet({ source, selectors: DEFAULT_SELECTORS, preload: false });

    const { convertedTools } = await convertMCPServersToTools({ tfyManagedServers: [], userServers: [toolSet] });

    expect(convertedTools.tools).toHaveLength(0);
    expect(toolSet.preload).toBe(false);
  });

  it('honors an explicit preload: true regardless of tool count', async () => {
    const toolCount = MCP_AUTO_PRELOAD_MAX_TOOLS + 12;
    const source = makeFakeSource({ name: 'explicit-preloaded', toolCount });
    const toolSet = new ToolSet({ source, selectors: DEFAULT_SELECTORS, preload: true });

    const { convertedTools } = await convertMCPServersToTools({ tfyManagedServers: [], userServers: [toolSet] });

    expect(convertedTools.tools).toHaveLength(toolCount);
    expect(toolSet.preload).toBe(true);
  });

  it('degrades a small server to deferred discovery when its initialise probe fails, surfacing the failure reason in tool result text when later used', async () => {
    const failure = new McpConnectionError("Failed to connect to remote MCP server 'flaky': ECONNREFUSED", 502);
    const source = makeFakeSource({ name: 'flaky', toolCount: 2, failure });
    const toolSet = new ToolSet({ source, selectors: DEFAULT_SELECTORS, preload: undefined });

    // The initialise probe (listTools()) must not throw out of the batched aggregation.
    const listed = await toolSet.listTools();
    expect('result' in listed && listed.result.tools).toEqual([]);
    expect(toolSet.preload).toBe(false);
    expect(toolSet.preloadPending).toBe(false);

    // The same failure resurfaces, in tool result text, the next time the server is actually used
    // through the deferred meta-tools — no special-casing needed beyond the existing error wrapping.
    const deferredTool = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() });
    const result = await deferredTool.callTool({
      name: 'call_tool',
      arguments: { mcp_server: 'flaky', tool_name: 'tool_0', input: {} },
    });
    if (!('result' in result)) throw new Error('expected a result response');
    const text = result.result.content.map(c => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('ECONNREFUSED');
  });

  it('never re-resolves auto-preload once decided (initialise happens once, not per listTools() call)', async () => {
    const source = makeFakeSource({ name: 'stable', toolCount: 2 });
    const toolSet = new ToolSet({ source, selectors: DEFAULT_SELECTORS, preload: undefined });

    await toolSet.listTools();
    await toolSet.listTools();
    await toolSet.listTools();

    expect(toolSet.preload).toBe(true);
    expect(source.listTools).toHaveBeenCalledTimes(3);
  });
});
