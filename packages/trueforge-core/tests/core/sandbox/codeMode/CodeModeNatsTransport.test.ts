import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { createRoutedCodeModeWebSocket } from '../../../../src/core/sandbox/codeMode/nats/CodeModeNatsTransport';

interface NatsWebSocketFixture {
  server: Server;
  webSocketServer: WebSocketServer;
  port: number;
  hostHeader: () => string | undefined;
}

async function createNatsWebSocketFixture(): Promise<NatsWebSocketFixture> {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  let receivedHost: string | undefined;
  webSocketServer.on('connection', (_socket, request) => {
    receivedHost = request.headers.host;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP test server address');
  }
  return {
    server,
    webSocketServer,
    port: address.port,
    hostHeader: () => receivedHost,
  };
}

async function closeFixture(fixture: NatsWebSocketFixture): Promise<void> {
  for (const client of fixture.webSocketServer.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    fixture.webSocketServer.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixture.server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('CodeModeNatsTransport routed WebSocket connection', () => {
  it('connects to the dial URL while retaining the signed preview Host header', async () => {
    const fixture = await createNatsWebSocketFixture();
    const signedHost = `4444-signed.proxy.localhost:${String(fixture.port)}`;
    const socket = createRoutedCodeModeWebSocket({
      url: `ws://${signedHost}/nats?token=abc`,
      dialUrl: `ws://127.0.0.1:${String(fixture.port)}/nats?token=abc`,
    });

    try {
      await once(socket, 'open');
      expect(fixture.hostHeader()).toBe(signedHost);
    } finally {
      socket.terminate();
      await closeFixture(fixture);
    }
  });
});
