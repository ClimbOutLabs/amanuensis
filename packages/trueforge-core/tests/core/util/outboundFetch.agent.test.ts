/**
 * The MCP connection's own timeouts, on a real undici Agent against a real local server that
 * stalls: before its headers, and in the middle of its body.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  OutboundRedirectRefusedError,
  configureOutboundFetches,
  isOutboundBodyTimeout,
  mcpOutboundBaseFetch,
  modelOutboundFetch,
} from '../../../src/core/util/outboundFetch';

const TIMEOUTS = { connectTimeoutMs: 1_000, headersTimeoutMs: 300, bodyTimeoutMs: 300, maxRetries: 0 };

describe('the MCP connection timeouts', () => {
  let server: Server;
  let origin: string;
  const open: ServerResponse[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      open.push(res);
      if (req.url === '/stall-body') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
      }
      // Otherwise nothing is ever sent, not even headers.
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('local server did not bind a TCP port');
    }
    origin = `http://127.0.0.1:${String(address.port)}`;
    configureOutboundFetches({ model: TIMEOUTS, mcp: TIMEOUTS });
  });

  afterAll(async () => {
    for (const res of open) {
      res.destroy();
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('gives up on a server that never starts answering after the headers timeout', async () => {
    const started = Date.now();
    const failure: unknown = await mcpOutboundBaseFetch(`${origin}/stall-headers`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.cause : undefined).toMatchObject({ code: 'UND_ERR_HEADERS_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('drops a body that goes quiet after the body timeout, and the error reads as a body timeout', async () => {
    const response = await mcpOutboundBaseFetch(`${origin}/stall-body`);
    expect(response.status).toBe(200);
    const failure: unknown = await response.text().catch((error: unknown) => error);
    expect(isOutboundBodyTimeout(failure)).toBe(true);
  });
});

describe('the model redirect check', () => {
  let server: Server;
  let origin: string;
  let dialsOfTarget = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/start') {
        // The redirect target is this same loopback server: an address a provider whose base
        // URL passed the check could still try to send the request to.
        res.writeHead(302, { location: `${origin}/target` });
        res.end();
        return;
      }
      if (req.url === '/target') {
        dialsOfTarget += 1;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('reached');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('local server did not bind a TCP port');
    }
    origin = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('refuses a redirect to an address the check fails, and never dials it', async () => {
    configureOutboundFetches({
      model: TIMEOUTS,
      mcp: TIMEOUTS,
      modelRedirectCheck: async () => false,
    });
    dialsOfTarget = 0;
    await expect(modelOutboundFetch(`${origin}/start`)).rejects.toBeInstanceOf(OutboundRedirectRefusedError);
    expect(dialsOfTarget).toBe(0);
  });

  it('follows a redirect the check passes', async () => {
    configureOutboundFetches({
      model: TIMEOUTS,
      mcp: TIMEOUTS,
      modelRedirectCheck: async () => true,
    });
    const response = await modelOutboundFetch(`${origin}/start`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('reached');
    expect(dialsOfTarget).toBe(1);
  });
});
