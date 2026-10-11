/**
 * A connection the host vouches for must not hand that trust to wherever its origin redirects.
 * These tests run the real MCP transports against real local servers: an origin that answers every
 * request with a redirect, and a target that records whether anything ever reached it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpConnectionError, RemoteMCP } from '../../../src/core';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import { makeSilentLogger } from '../harnessMocks';

interface LocalServer {
  origin: string;
  /** `METHOD /path` for every request received, in order. */
  hits: string[];
  close: () => Promise<void>;
}

async function listen(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<LocalServer> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`);
    req.resume();
    res.setHeader('connection', 'close');
    handle(req, res);
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('local server did not bind a TCP port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(new Error('local server failed to close', { cause: error }));
            return;
          }
          resolve();
        });
      });
    },
  };
}

describe('redirects on a remote MCP connection', () => {
  let target: LocalServer;
  let origin: LocalServer;
  let redirectStatus = 302;

  beforeEach(async () => {
    redirectStatus = 302;
    target = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    origin = await listen((req, res) => {
      res.writeHead(redirectStatus, { location: `${target.origin}${req.url ?? '/'}?token=hunter2` });
      res.end();
    });
  });

  afterEach(async () => {
    await origin.close();
    await target.close();
  });

  const connectParams = () => ({
    url: `${origin.origin}/mcp`,
    headers: {},
    requestTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    signal: new AbortController().signal,
  });

  describe('when the connection refuses them', () => {
    it.each([301, 302, 303, 307, 308])(
      'refuses an HTTP %i from the origin, says where it led, and never reaches the target',
      async status => {
        redirectStatus = status;

        const refused = connectRemoteMcp({ ...connectParams(), refuseRedirects: true });

        await expect(refused).rejects.toBeInstanceOf(McpConnectionError);
        await expect(refused).rejects.toMatchObject({
          statusCode: 502,
          message: `server answered HTTP ${String(status)} with a redirect to ${target.origin}, and this connection does not follow redirects`,
        });
        expect(target.hits).toEqual([]);
      },
    );

    it('keeps the secret in the redirect location out of the message', async () => {
      const error = await connectRemoteMcp({ ...connectParams(), refuseRedirects: true }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toMatchObject({ message: expect.not.stringContaining('hunter2') });
      expect(error).toBeInstanceOf(McpConnectionError);
    });

    it('gives up at the first transport instead of trying the other one on the same URL', async () => {
      await expect(connectRemoteMcp({ ...connectParams(), refuseRedirects: true })).rejects.toBeInstanceOf(
        McpConnectionError,
      );

      expect(origin.hits).toEqual(['POST /mcp']);
    });

    it('refuses on the event-stream transport too', async () => {
      await expect(
        connectRemoteMcp({ ...connectParams(), knownTransportType: 'sse', refuseRedirects: true }),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: expect.stringContaining('with a redirect to'),
      });

      expect(origin.hits).toEqual(['GET /mcp']);
      expect(target.hits).toEqual([]);
    });

    it('reaches a RemoteMCP caller as a connection error that names the server', async () => {
      const remote = new RemoteMCP({
        name: 'memory',
        id: 'memory',
        url: `${origin.origin}/mcp`,
        headers: {},
        logger: makeSilentLogger(),
        requestTimeoutMs: 5_000,
        connectTimeoutMs: 5_000,
        signal: new AbortController().signal,
        refuseRedirects: true,
      });

      await expect(remote.listTools()).rejects.toMatchObject({
        statusCode: 502,
        message: expect.stringMatching(/^Failed to connect to remote MCP server 'memory': .*with a redirect to/),
      });
      expect(target.hits).toEqual([]);
    });
  });

  describe('when the connection does not ask to refuse them', () => {
    it('does not follow a redirect to another origin, which would forward its credentials', async () => {
      redirectStatus = 307;

      await expect(connectRemoteMcp(connectParams())).rejects.toBeInstanceOf(McpConnectionError);

      expect(target.hits).toEqual([]);
    });
  });
});
