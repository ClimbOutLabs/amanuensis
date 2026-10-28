import { McpConnectionError, McpRedirectRefusedError } from '../../../src/core/errors';
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

  it('still fails the conversion when the server answered with a redirect the connection refuses', async () => {
    // The shape a refused redirect takes by the time it reaches conversion: the refusal
    // itself, and the same refusal riding as the cause under the connect wrapper that names
    // the server (a plain 502, which on its own would read as unavailability). The server
    // was reached and answered, so neither shape may be left out as unavailable.
    const refusal = new McpRedirectRefusedError(
      'server answered HTTP 302 with a redirect to http://127.0.0.1:34101, and this connection does not follow redirects',
    );
    await expect(
      convertMCPServersToTools({
        tfyManagedServers: [],
        userServers: [makeFailingServer({ name: 'memory', error: refusal })],
      }),
    ).rejects.toThrow('this connection does not follow redirects');

    const wrapped = new McpConnectionError(`Failed to connect to remote MCP server 'memory': ${refusal.message}`, 502, {
      cause: refusal,
    });
    await expect(
      convertMCPServersToTools({
        tfyManagedServers: [],
        userServers: [makeFailingServer({ name: 'memory', error: wrapped })],
      }),
    ).rejects.toThrow("Failed to connect to remote MCP server 'memory'");
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
