import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { DeferredTool, LIST_TOOLS_NAME } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import '../harnessMocks';
import { makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

const silentLogger = makeSilentLogger();

async function listToolsText(deferredTool: DeferredTool, mcpServer: string): Promise<string> {
  const response = await deferredTool.callTool({ name: LIST_TOOLS_NAME, arguments: { mcp_server: mcpServer } });
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a resolved list_tools response');
  }
  const first = response.result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  return first.text;
}

describe('DeferredTool scripted model session', () => {
  it('settles each call of the reported session: two unknown servers, then a real one', async () => {
    const server = makeMockIMCPServer({
      name: 'parallel-web',
      preload: false,
      tools: [
        { name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
        { name: 'fetch', description: 'fetch', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
      ],
    });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const results = [
      await listToolsText(deferredTool, 'gmail'),
      await listToolsText(deferredTool, 'sub_agents'),
      await listToolsText(deferredTool, 'parallel-web'),
    ];

    const unknownServer = (name: string) =>
      JSON.stringify({
        error: `No server named '${name}'. Servers: parallel-web. Built-in tools are called directly by name, never through call_tool.`,
      });
    expect(results).toEqual([unknownServer('gmail'), unknownServer('sub_agents'), 'parallel-web:\n  search, fetch']);
  });

  it('returns an error, not a pending call, when a connector fails to list its tools', async () => {
    const server = {
      ...makeMockIMCPServer({ name: 'parallel-web', preload: false }),
      listTools: jest.fn(() => Promise.reject(new Error('upstream timed out'))),
    };
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const text = await listToolsText(deferredTool, 'parallel-web');

    expect(JSON.parse(text)).toEqual({ error: "Failed to list tools for 'parallel-web'." });
  });
});
