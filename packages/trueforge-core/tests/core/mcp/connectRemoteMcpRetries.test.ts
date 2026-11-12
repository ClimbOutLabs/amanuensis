/**
 * Retries on a remote MCP connection replay the whole request through the redirect guard and the
 * response size cap, so neither check can be skipped by a server that first answers "try again".
 * These run the real transports against real local servers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpConnectionError } from '../../../src/core';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';

interface LocalServer {
  origin: string;
  /** `METHOD /path` for every request received, in order. */
  hits: string[];
  close: () => Promise<void>;
}

async function listen(handle: (req: IncomingMessage, res: ServerResponse, hit: number) => void): Promise<LocalServer> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`);
    req.resume();
    res.setHeader('connection', 'close');
    handle(req, res, hits.length);
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

function tryAgain(res: ServerResponse): void {
  res.writeHead(429, { 'retry-after': '0' });
  res.end();
}

describe('retries on a remote MCP connection', () => {
  const servers: LocalServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
  });

  const connectParams = (url: string) => ({
    url,
    headers: {},
    requestTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    signal: new AbortController().signal,
    knownTransportType: 'streamable-http' as const,
  });

  it('runs the redirect guard on the retried request', async () => {
    const target = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const origin = await listen((req, res, hit) => {
      if (hit === 1) {
        tryAgain(res);
        return;
      }
      res.writeHead(302, { location: `${target.origin}${req.url ?? '/'}` });
      res.end();
    });
    servers.push(target, origin);

    await expect(
      connectRemoteMcp({ ...connectParams(`${origin.origin}/mcp`), refuseRedirects: true }),
    ).rejects.toMatchObject({ message: expect.stringContaining('with a redirect to') });

    expect(origin.hits).toEqual(['POST /mcp', 'POST /mcp']);
    expect(target.hits).toEqual([]);
  });

  it('runs the response size cap on the retried request', async () => {
    const origin = await listen((_req, res, hit) => {
      if (hit === 1) {
        tryAgain(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { padding: 'x'.repeat(4_096) } }));
    });
    servers.push(origin);

    const failure: unknown = await connectRemoteMcp({
      ...connectParams(`${origin.origin}/mcp`),
      maxResponseBytes: 1_024,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpConnectionError);
    expect(failure instanceof Error ? failure.message : '').toContain('exceeded max 1024 bytes');
    expect(origin.hits.slice(0, 2)).toEqual(['POST /mcp', 'POST /mcp']);
  });
});
