import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { isCallToolResponseResult, toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import '../harnessMocks';
import { makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

const silentLogger = makeSilentLogger();

async function callTool(
  deferredTool: DeferredTool,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const response = await deferredTool.callTool({ name: 'call_tool', arguments: args });
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a resolved call_tool response');
  }
  const first = response.result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  return { text: first.text, isError: response.result.isError === true };
}

describe('DeferredTool call_tool host-tool routing', () => {
  it('routes a call_tool tool_name that matches a host tool instead of rejecting it', async () => {
    const server = makeMockIMCPServer({
      name: 'tavily',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    const hostTool = makeMockIMCPServer({
      name: 'current-datetime',
      preload: true,
      tools: [
        { name: 'get_current_datetime', description: 'datetime', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      ],
    });
    (hostTool.callTool as jest.Mock).mockResolvedValue(
      toolResultResponse({ text: JSON.stringify({ iso: '2026-09-15T01:19:00.000Z' }) }),
    );
    jest.mocked(hostTool.toolCallInfo).mockResolvedValue({
      type: 'truefoundry-system',
      mcp_server_id: 'current-datetime',
      mcp_server_name: 'current-datetime',
      original_tool_name: 'get_current_datetime',
      tier: 1,
    });
    const deferredTool = new DeferredTool([server], {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      hostToolSets: [hostTool],
    });

    const { text, isError } = await callTool(deferredTool, {
      mcp_server: 'tavily',
      tool_name: 'get_current_datetime',
      input: {},
    });

    expect(isError).toBe(false);
    expect(text).toContain('routed');
    expect(hostTool.callTool).toHaveBeenCalledWith({ name: 'get_current_datetime', arguments: {} });
    // The original host-tool result is still present as a second content block.
    const response = await deferredTool.callTool({
      name: 'call_tool',
      arguments: { mcp_server: 'tavily', tool_name: 'get_current_datetime', input: {} },
    });
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a resolved call_tool response');
    }
    const second = response.result.content[1];
    expect(second?.type).toBe('text');
    expect(second?.type === 'text' ? second.text : undefined).toBe(JSON.stringify({ iso: '2026-09-15T01:19:00.000Z' }));
  });

  it('still rejects a tool_name matching neither the server nor any host tool', async () => {
    const server = makeMockIMCPServer({
      name: 'tavily',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    const hostTool = makeMockIMCPServer({
      name: 'current-datetime',
      preload: true,
      tools: [
        { name: 'get_current_datetime', description: 'datetime', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      ],
    });
    const deferredTool = new DeferredTool([server], {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      hostToolSets: [hostTool],
    });

    const { text, isError } = await callTool(deferredTool, {
      mcp_server: 'tavily',
      tool_name: 'does_not_exist_anywhere',
      input: {},
    });

    expect(isError).toBe(true);
    expect(hostTool.callTool).not.toHaveBeenCalled();
    const parsed = JSON.parse(text) as { error?: string };
    expect(parsed.error).toContain("expected the name of a tool on 'tavily'");
  });

  it('never routes to a host tool when the tool_name exists on the named server', async () => {
    const server = makeMockIMCPServer({
      name: 'tavily',
      preload: false,
      tools: [
        { name: 'get_current_datetime', description: 'server tool', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
      ],
    });
    (server.callTool as jest.Mock).mockResolvedValue(toolResultResponse({ text: 'from-server' }));
    const hostTool = makeMockIMCPServer({
      name: 'current-datetime',
      preload: true,
      tools: [
        { name: 'get_current_datetime', description: 'datetime', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      ],
    });
    const deferredTool = new DeferredTool([server], {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      hostToolSets: [hostTool],
    });

    const { text } = await callTool(deferredTool, {
      mcp_server: 'tavily',
      tool_name: 'get_current_datetime',
      input: {},
    });

    expect(text).toBe('from-server');
    expect(hostTool.callTool).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<InternalToolCallInfo>]>([
    ['needs an approval', { tier: 3, is_approval_required: true }],
    ['was refused before dispatch', { tier: 3, pre_dispatch_failure: { kind: 'policy_blocked', message: 'no' } }],
  ])('never runs a host tool that %s, and tells the model to call it directly', async (_name, extra) => {
    const server = makeMockIMCPServer({
      name: 'notes',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    const hostTool = makeMockIMCPServer({
      name: 'gmail',
      preload: true,
      tools: [{ name: 'send_draft', description: 'send', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
    });
    jest.mocked(hostTool.toolCallInfo).mockResolvedValue({
      type: 'truefoundry-system',
      mcp_server_id: 'gmail',
      mcp_server_name: 'gmail',
      original_tool_name: 'send_draft',
      ...extra,
    });
    const deferredTool = new DeferredTool([server], {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      hostToolSets: [hostTool],
    });

    const { text, isError } = await callTool(deferredTool, {
      mcp_server: 'notes',
      tool_name: 'send_draft',
      input: { draft_id: 'd1' },
    });

    expect(isError).toBe(true);
    expect(hostTool.callTool).not.toHaveBeenCalled();
    expect(text).toContain('call send_draft directly');
  });

  it('refuses host routing when the call was approved against the named server', async () => {
    const server = makeMockIMCPServer({
      name: 'tavily',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    const hostTool = makeMockIMCPServer({
      name: 'current-datetime',
      preload: true,
      tools: [
        { name: 'get_current_datetime', description: 'datetime', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      ],
    });
    const deferredTool = new DeferredTool([server], {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      hostToolSets: [hostTool],
    });

    const response = await deferredTool.callTool(
      { name: 'call_tool', arguments: { mcp_server: 'tavily', tool_name: 'get_current_datetime', input: {} } },
      { status: 'allow', scope: 'once' },
    );

    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a resolved call_tool response');
    }
    expect(response.result.isError).toBe(true);
    expect(hostTool.callTool).not.toHaveBeenCalled();
  });
});
