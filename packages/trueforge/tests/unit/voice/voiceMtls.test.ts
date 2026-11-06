/** Voice lines on a server with mutual TLS on: the server's own calls must get through, outside ones must not. */
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { createLogger, transports } from 'winston';
import WebSocket from 'ws';

import { createVoiceRouter } from '../../../src/apis/voice';
import type { Authenticator } from '../../../src/auth/authenticator';
import { STANDALONE_REQUEST_CONTEXT, resolveRequestContext } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import configuration from '../../../src/config';
import { createClientCertificateMiddleware } from '../../../src/http/tls';
import { VOICE_SOCKET_PROTOCOL, VOICE_STREAM_PATH } from '../../../src/voice/browserTransport';
import { SpeechRateLimiter } from '../../../src/voice/speechRateLimit';
import { attachVoiceSocket, requestAs, type SessionParts } from '../../../src/voice/voiceSocket';
import { voiceTickets, type VoiceTicketClaims } from '../../../src/voice/voiceTickets';
import { FakeStt, FakeTts, FakeTurns, LoudnessVad } from '../../fixtures/voice/fakes';

jest.mock('../../../src/voice/sttAvailability', () => ({
  ...jest.requireActual('../../../src/voice/sttAvailability'),
  isVoiceAvailable: () => true,
}));
jest.mock('../../../src/voice/ttsClient', () => ({
  ...jest.requireActual('../../../src/voice/ttsClient'),
  probeTtsHealth: () => Promise.resolve(true),
}));
jest.mock('../../../src/voice/voiceSocket', () => ({
  ...jest.requireActual('../../../src/voice/voiceSocket'),
  readyVadModel: () => Promise.resolve(new Uint8Array()),
}));

const logger = createLogger({ transports: [new transports.Console({ silent: true })] });

const authenticator: Authenticator = {
  authenticate: c => {
    const user = /user=(\w+)/.exec(c.req.header('cookie') ?? '')?.[1];
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    return Promise.resolve({
      ...STANDALONE_REQUEST_CONTEXT,
      tenant_id: 'tenant-a',
      subject: { id: user, type: 'user', display_name: user },
    });
  },
};

/** The server as it runs with mutual TLS on: every route needs a certificate, and voice calls back into it. */
function mtlsServer() {
  const app = new OpenAPIHono();
  app.use('*', createClientCertificateMiddleware(logger));
  app.use('*', createAuthMiddleware(authenticator));
  app.get('/api/v1/sessions/:id', c => c.json({ id: c.req.param('id') }));
  app.route(
    '/api/v1/voice',
    createVoiceRouter({
      logger,
      resolveRequestContext,
      app,
      connectLimiter: new SpeechRateLimiter({ maxPerWindow: 10, maxInFlight: 10 }),
    }),
  );
  return app;
}

/** What a person's browser connection looks like once the certificate check has passed. */
function authorizedSocket(): TLSSocket {
  const socket = new TLSSocket(new Socket());
  socket.authorized = true;
  return socket;
}

const TICKET: VoiceTicketClaims = {
  tenantId: 'tenant-a',
  subjectId: 'alice',
  sessionId: 'chat-1',
  headers: { cookie: 'user=alice', host: 'localhost' },
  timezone: undefined,
  voice: undefined,
};

const connectRequest = {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: 'user=alice', host: 'aman.local' },
  body: JSON.stringify({ session_id: 'chat-1' }),
};

describe('opening a voice line when mutual TLS is on', () => {
  beforeEach(() => {
    configuration.TTS_ENABLED = true;
  });

  it("checks the chat is the person's through the server itself, without a certificate on that inner call", async () => {
    const response = await mtlsServer().request('/api/v1/voice/connect', connectRequest, {
      incoming: { socket: authorizedSocket() },
    });
    expect(response.status).toBe(200);
  });

  it('still turns away a person who has no certificate', async () => {
    const response = await mtlsServer().request('/api/v1/voice/connect', connectRequest, {
      incoming: { socket: new Socket() },
    });
    expect(response.status).toBe(403);
  });
});

describe('the voice WebSocket when mutual TLS is on', () => {
  let server: Server;
  let port: number;
  let inner: number[];

  beforeEach(async () => {
    inner = [];
    server = createServer();
    attachVoiceSocket({
      server,
      app: mtlsServer(),
      pages: new Set(['http://app.test']),
      logger,
      makeParts: async ({ ticket, selfFetch }): Promise<SessionParts> => {
        const response = await requestAs({ ticket, selfFetch })('/api/v1/sessions/chat-1', { method: 'GET' });
        inner.push(response.status);
        return {
          vad: new LoudnessVad(),
          stt: new FakeStt('hi'),
          tts: new FakeTts(),
          turns: new FakeTurns({ message: [{ text: ['Hello.'] }] }),
        };
      },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the test server has no port');
    }
    port = address.port;
  });

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    server.closeAllConnections();
    await new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('runs the turns of a line through the server itself, past the certificate check', async () => {
    const { id } = voiceTickets.issue(TICKET);
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(port)}${VOICE_STREAM_PATH}`,
      [VOICE_SOCKET_PROTOCOL, `ticket.${id}`],
      { headers: { origin: 'http://app.test' } },
    );
    await new Promise(resolve => socket.on('open', resolve));
    await new Promise(resolve => setTimeout(resolve, 100));
    socket.close();
    expect(inner).toEqual([200]);
  });
});

/** Runs the server's upgrade handler by hand, so a test can choose what kind of connection it came from. */
function upgradeAttempt({
  requireClientCertificate,
  connection,
}: {
  requireClientCertificate: boolean;
  connection: Socket;
}) {
  let listener: ((request: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined;
  attachVoiceSocket({
    server: {
      on: (_event, handler) => {
        listener = handler;
      },
    },
    app: mtlsServer(),
    pages: new Set(['http://app.test']),
    logger,
    requireClientCertificate,
  });
  const written: string[] = [];
  const raw = new Socket();
  raw.write = (chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  };
  raw.destroy = () => raw;
  // A request is only the parts the handler reads.
  const request = Object.assign(Object.create(null) as IncomingMessage, {
    url: VOICE_STREAM_PATH,
    headers: { origin: 'http://app.test', 'sec-websocket-protocol': VOICE_SOCKET_PROTOCOL },
    socket: connection,
  });
  listener?.(request, raw, Buffer.alloc(0));
  return written.join('');
}

describe('who may open a voice WebSocket when mutual TLS is on', () => {
  it('turns away a connection without a verified certificate, before it looks at the ticket', () => {
    expect(upgradeAttempt({ requireClientCertificate: true, connection: new Socket() })).toContain('403 Forbidden');
  });

  it('turns away a connection whose certificate our authority did not vouch for', () => {
    const connection = new TLSSocket(new Socket());
    expect(upgradeAttempt({ requireClientCertificate: true, connection })).toContain('403 Forbidden');
  });

  it('lets a verified connection on to the ticket check', () => {
    expect(upgradeAttempt({ requireClientCertificate: true, connection: authorizedSocket() })).toContain(
      '401 Unauthorized',
    );
  });

  it('does not ask for a certificate when mutual TLS is off', () => {
    expect(upgradeAttempt({ requireClientCertificate: false, connection: new Socket() })).toContain('401 Unauthorized');
  });
});
