import { isCallToolResponseResult, toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { DeferredTool, GET_TOOL_INFO_NAME, LIST_TOOLS_NAME } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import '../harnessMocks';
import { makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

const silentLogger = makeSilentLogger();

async function callToolErrorText(
  deferredTool: DeferredTool,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = await deferredTool.callTool({ name, arguments: args });
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a resolved call_tool response');
  }
  const first = response.result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  const parsed = JSON.parse(first.text) as { error?: string };
  if (parsed.error === undefined) {
    throw new Error(`Expected an error field, got: ${first.text}`);
  }
  return parsed.error;
}

async function callToolTextResult(
  deferredTool: DeferredTool,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = await deferredTool.callTool({ name, arguments: args });
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a resolved call_tool response');
  }
  const first = response.result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  return first.text;
}

describe('DeferredTool call_tool rejections', () => {
  it('names the configured servers when mcp_server does not exist', async () => {
    const server = makeMockIMCPServer({
      name: 'parallel-web',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const error = await callToolErrorText(deferredTool, 'call_tool', {
      mcp_server: 'not-a-server',
      tool_name: 'search',
      input: {},
    });

    expect(error).toBe(
      "call_tool rejected the mcp_server: received 'not-a-server'; expected the name of a configured MCP server. Configured servers: parallel-web.",
    );
  });

  it('says call_tool naming itself is top-level, not a server tool', async () => {
    const server = makeMockIMCPServer({
      name: 'parallel-web',
      preload: false,
      tools: [
        { name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
        { name: 'fetch', description: 'fetch', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
      ],
    });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const error = await callToolErrorText(deferredTool, 'call_tool', {
      mcp_server: 'parallel-web',
      tool_name: 'call_tool',
      input: {},
    });

    expect(error).toBe(
      "call_tool rejected the tool_name: received 'call_tool'; expected the name of a tool on 'parallel-web'. 'call_tool' is a top-level tool, not a server tool; call it directly instead of through call_tool.",
    );
  });

  it('aliases call_tool with tool_name "list_tools" to running list_tools directly', async () => {
    const server = makeMockIMCPServer({
      name: 'tavily',
      preload: false,
      tools: [
        { name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
        { name: 'fetch', description: 'fetch', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
      ],
    });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const text = await callToolTextResult(deferredTool, 'call_tool', {
      mcp_server: 'tavily',
      tool_name: 'list_tools',
      input: {},
    });

    expect(text).toBe('tavily:\n  search, fetch');
  });

  it('aliases call_tool with tool_name "get_tool_info" to running get_tool_info directly', async () => {
    const server = makeMockIMCPServer({
      name: 'tavily',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const text = await callToolTextResult(deferredTool, 'call_tool', {
      mcp_server: 'tavily',
      tool_name: 'get_tool_info',
      input: { tool_name: 'search' },
    });

    expect(JSON.parse(text)).toEqual({
      description: 'search',
      inputSchema: OBJECT_INPUT_SCHEMA,
      outputSchema: null,
    });
  });

  it('rejects the aliased get_tool_info call when input is missing tool_name', async () => {
    const server = makeMockIMCPServer({
      name: 'tavily',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const error = await callToolErrorText(deferredTool, 'call_tool', {
      mcp_server: 'tavily',
      tool_name: 'get_tool_info',
      input: {},
    });

    expect(error).toBe(
      "call_tool rejected the input: received input missing tool_name; expected arguments for 'get_tool_info': { tool_name }. Call call_tool with tool_name 'get_tool_info' and input.tool_name set to the tool to inspect.",
    );
  });

  it('names the tools that exist on the server when tool_name is unknown there', async () => {
    const server = makeMockIMCPServer({
      name: 'parallel-web',
      preload: false,
      tools: [
        { name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
        { name: 'fetch', description: 'fetch', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
      ],
    });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const error = await callToolErrorText(deferredTool, 'call_tool', {
      mcp_server: 'parallel-web',
      tool_name: 'not_a_real_tool',
      input: {},
    });

    expect(error).toBe(
      "call_tool rejected the tool_name: received 'not_a_real_tool'; expected the name of a tool on 'parallel-web'. Tools on 'parallel-web': search, fetch.",
    );
  });

  it('dispatches to the server when the tool exists there', async () => {
    const server = makeMockIMCPServer({
      name: 'parallel-web',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    (server.callTool as jest.Mock).mockResolvedValue(toolResultResponse({ text: 'ok' }));
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const text = await callToolTextResult(deferredTool, 'call_tool', {
      mcp_server: 'parallel-web',
      tool_name: 'search',
      input: {},
    });

    expect(text).toBe('ok');
    expect(server.callTool).toHaveBeenCalledWith({ name: 'search', arguments: {} }, undefined);
  });
});

describe('DeferredTool get_tool_info rejections', () => {
  it('names the configured servers when mcp_server does not exist', async () => {
    const server = makeMockIMCPServer({ name: 'parallel-web', preload: false });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const error = await callToolErrorText(deferredTool, GET_TOOL_INFO_NAME, {
      mcp_server: 'not-a-server',
      tool_name: 'search',
    });

    expect(error).toBe(
      "get_tool_info rejected the mcp_server: received 'not-a-server'; expected the name of a configured MCP server. Configured servers: parallel-web.",
    );
  });

  it('still lists raw tool names via list_tools', async () => {
    const server = makeMockIMCPServer({
      name: 'parallel-web',
      preload: false,
      tools: [
        { name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
        { name: 'fetch', description: 'fetch', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
      ],
    });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const text = await callToolTextResult(deferredTool, LIST_TOOLS_NAME, { mcp_server: 'parallel-web' });

    expect(text).toBe('parallel-web:\n  search, fetch');
  });
});
