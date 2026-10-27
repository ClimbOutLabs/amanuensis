import { McpConnectionError } from '../../../src/core/errors';
import type { IToolSet, ListToolsResponse } from '../../../src/core/mcp/IMCPServer';
import { convertMCPServersToTools } from '../../../src/core/mcp/convertMCPServers';
import '../harnessMocks';
import { makeMockIMCPServer } from '../harnessMocks';

function makeFailingServer(params: { name: string; error: unknown }): IToolSet {
  const base = makeMockIMCPServer({ name: params.name, preload: true });
  return {
    ...base,
    listTools: jest.fn((): Promise<ListToolsResponse> => Promise.reject(params.error)),
  };
}

describe('convertMCPServersToTools with an unreachable server', () => {
  it("leaves the unreachable server's tools out and still converts the other servers", async () => {
    // The shape a dead server produces: a transport failure (502) whose message names the
    // server and the reason, with the raw fetch failure kept as the cause.
    const transportFailure = new McpConnectionError(
      'The Email server could not be reached: connection refused at 192.168.144.3:9557.',
      502,
      { cause: new TypeError('fetch failed') },
    );

    const { convertedTools, unavailableInfo } = await convertMCPServersToTools({
      tfyManagedServers: [makeMockIMCPServer({ name: 'spaces', preload: true })],
      userServers: [makeFailingServer({ name: 'Email', error: transportFailure })],
    });

    expect(convertedTools.tools).toHaveLength(1);
    const onlyTool = convertedTools.tools[0];
    if (onlyTool?.type !== 'function') throw new Error('expected a function tool');
    expect(onlyTool.function.name).toBe('tool_a');
    expect(convertedTools.toolMapping.get('tool_a')?.toolSet.name).toBe('spaces');
    expect(unavailableInfo).toEqual([
      { name: 'Email', message: 'The Email server could not be reached: connection refused at 192.168.144.3:9557.' },
    ]);
  });

  it('still fails the conversion for a failure that is not unavailability', async () => {
    const notFound = new McpConnectionError('Requested tools not found in MCP server Email: send_email', 422);
    await expect(
      convertMCPServersToTools({
        tfyManagedServers: [],
        userServers: [makeFailingServer({ name: 'Email', error: notFound })],
      }),
    ).rejects.toThrow('Requested tools not found in MCP server Email: send_email');

    await expect(
      convertMCPServersToTools({
        tfyManagedServers: [],
        userServers: [makeFailingServer({ name: 'Email', error: new Error('boom') })],
      }),
    ).rejects.toThrow('boom');
  });
});
