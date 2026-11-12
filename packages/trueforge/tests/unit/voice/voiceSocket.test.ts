import { IncomingMessage, createServer, type Server } from 'node:http';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import WebSocket from 'ws';
import { winstonSilent } from '../../fixtures/voice/silentLogger';

import { VoiceServerEventSchema, type VoiceServerEvent } from '@truefoundry/trueforge-core/schemas/voiceLine';
import { pageOrigins } from '../../../src/auth/requestGuard';
import { VOICE_SOCKET_PROTOCOL, VOICE_STREAM_PATH } from '../../../src/voice/browserTransport';
import { attachVoiceSocket, originAllowed, requestAs, turnRunnerFor } from '../../../src/voice/voiceSocket';
import {
  VoiceTicketStore,
  VoiceTicketsFullError,
  voiceTickets,
  type VoiceTicketClaims,
} from '../../../src/voice/voiceTickets';
import { FakeStt, FakeTts, FakeTurns, LoudnessVad, hum, pcmBytes, quiet } from '../../fixtures/voice/fakes';
import { authorizedSocket, mtlsApp } from '../../fixtures/voice/mtlsApp';

const TICKET: VoiceTicketClaims = {
  tenantId: 't1',
  subjectId: 'u1',
  sessionId: 's1',
  headers: { cookie: 'session=abc', host: 'localhost' },
  timezone: undefined,
  voice: undefined,
};

describe('VoiceTicketStore', () => {
  it('redeems a ticket once and never again', () => {
    const store = new VoiceTicketStore();
    const { id } = store.issue(TICKET);
    expect(store.redeem(id)).toEqual(TICKET);
    expect(store.redeem(id)).toBeUndefined();
  });

  it('lets one person crowd out only their own tickets, and refuses rather than evict anyone else', () => {
    const store = new VoiceTicketStore();
    const first = store.issue(TICKET);
    for (let n = 0; n < 5; n += 1) {
      store.issue(TICKET);
    }
    expect(store.redeem(first.id)).toBeUndefined();
    const other = store.issue({ ...TICKET, subjectId: 'u2' });
    expect(store.redeem(other.id)).toMatchObject({ subjectId: 'u2' });

    const crowded = new VoiceTicketStore();
    for (let n = 0; n < 200; n += 1) {
      for (let k = 0; k < 5; k += 1) {
        crowded.issue({ ...TICKET, subjectId: `person-${String(n)}` });
      }
    }
    expect(() => crowded.issue({ ...TICKET, subjectId: 'latecomer' })).toThrow(VoiceTicketsFullError);
  });

  it('refuses an expired or unknown ticket', () => {
    let now = 0;
    const store = new VoiceTicketStore({ now: () => now });
    const { id } = store.issue(TICKET);
    now = 31_000;
    expect(store.redeem(id)).toBeUndefined();
    expect(store.redeem('never-issued')).toBeUndefined();
  });
});

const PAGE = 'http://app.test';

describe('the voice WebSocket', () => {
  let server: Server;
  let port: number;
  let sentToApp: string[];
  let disposed: number;
  let setupMs: number;
  let maxSessions: number;

  beforeEach(async () => {
    sentToApp = [];
    disposed = 0;
    setupMs = 0;
    maxSessions = 20;
    server = createServer();
    attachVoiceSocket({
      server,
      pages: new Set([PAGE]),
      logger: winstonSilent(),
      app: {
        fetch: request => {
          sentToApp.push(request.url);
          return new Response('{}');
        },
      },
      requireClientCertificate: false,
      maxSessions,
      makeParts: async () => {
        await new Promise(resolve => setTimeout(resolve, setupMs));
        const vad = new LoudnessVad();
        return {
          vad: {
            probability: window => vad.probability(window),
            reset: () => vad.reset(),
            dispose: () => {
              disposed += 1;
              return Promise.resolve();
            },
          },
          stt: new FakeStt('what time is it'),
          tts: new FakeTts(),
          turns: new FakeTurns({ message: [{ text: ['It is nine o clock.'] }] }),
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
    // Sessions end a moment after their sockets close; let them finish before the next test counts.
    await new Promise(resolve => setTimeout(resolve, 150));
    await new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  });

  function open(ticket: string | undefined, extraHeaders: Record<string, string> = {}): WebSocket {
    const protocols = ticket === undefined ? [VOICE_SOCKET_PROTOCOL] : [VOICE_SOCKET_PROTOCOL, `ticket.${ticket}`];
    return new WebSocket(`ws://127.0.0.1:${String(port)}${VOICE_STREAM_PATH}`, protocols, {
      headers: { origin: PAGE, ...extraHeaders },
    });
  }

  const refused = (socket: WebSocket): Promise<string> =>
    new Promise(resolve => {
      socket.on('unexpected-response', (_request, response) => {
        resolve(String(response.statusCode));
      });
      socket.on('error', () => undefined);
    });

  it('turns away a connection with no ticket, a made-up ticket, or a ticket used before', async () => {
    expect(await refused(open(undefined))).toBe('401');
    expect(await refused(open('made-up'))).toBe('401');
    const { id } = voiceTickets.issue(TICKET);
    const first = open(id);
    await new Promise(resolve => first.on('open', resolve));
    first.close();
    expect(await refused(open(id))).toBe('401');
  });

  it('releases the listening model when the socket closes while it is still being set up', async () => {
    setupMs = 150;
    const { id } = voiceTickets.issue(TICKET);
    const socket = open(id);
    await new Promise(resolve => socket.on('open', resolve));
    socket.close();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(disposed).toBe(1);
  });

  it('keeps one conversation per person when several connections open at once', async () => {
    setupMs = 100;
    const sockets = [voiceTickets.issue(TICKET), voiceTickets.issue(TICKET), voiceTickets.issue(TICKET)].map(ticket =>
      open(ticket.id),
    );
    await new Promise(resolve => setTimeout(resolve, 800));
    const stillOpen = sockets.filter(socket => socket.readyState === WebSocket.OPEN);
    expect(stillOpen).toHaveLength(1);
    // The two that were replaced while their model was loading let it go.
    expect(disposed).toBe(2);
    stillOpen.forEach(socket => socket.close());
  });

  it('does not let one person in several tenants take all the places', async () => {
    const sockets = [1, 2, 3].map(n => open(voiceTickets.issue({ ...TICKET, tenantId: `tenant-${String(n)}` }).id));
    await Promise.all(sockets.map(socket => new Promise(resolve => socket.on('open', resolve))));
    expect(await refused(open(voiceTickets.issue({ ...TICKET, tenantId: 'tenant-4' }).id))).toBe('503');
    sockets.forEach(socket => socket.close());
  });

  it('turns away a new person when the server is full', async () => {
    const full = createServer();
    attachVoiceSocket({
      server: full,
      pages: new Set([PAGE]),
      logger: winstonSilent(),
      app: { fetch: () => new Response('{}') },
      requireClientCertificate: false,
      maxSessions: 1,
      makeParts: () =>
        Promise.resolve({ vad: new LoudnessVad(), stt: new FakeStt(), tts: new FakeTts(), turns: new FakeTurns() }),
    });
    await new Promise<void>(resolve => full.listen(0, '127.0.0.1', resolve));
    const address = full.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the test server has no port');
    }
    const url = `ws://127.0.0.1:${String(address.port)}${VOICE_STREAM_PATH}`;
    const connect = (subject: string) =>
      new WebSocket(
        url,
        [VOICE_SOCKET_PROTOCOL, `ticket.${voiceTickets.issue({ ...TICKET, subjectId: subject }).id}`],
        {
          headers: { origin: PAGE },
        },
      );
    const first = connect('a');
    await new Promise(resolve => first.on('open', resolve));
    expect(await refused(connect('b'))).toBe('503');
    first.close();
    await new Promise<void>(resolve => {
      full.close(() => {
        resolve();
      });
      full.closeAllConnections();
    });
  });

  it('never logs what was said, what was answered, or the ticket', async () => {
    const logged: string[] = [];
    const logger = winstonSilent();
    for (const level of ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const) {
      jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
        return logger;
      });
    }
    const logServer = createServer();
    attachVoiceSocket({
      pages: new Set([PAGE]),
      server: logServer,
      logger,
      app: { fetch: () => new Response('{}') },
      requireClientCertificate: false,
      makeParts: () =>
        Promise.resolve({
          vad: new LoudnessVad(),
          stt: new FakeStt('my secret phrase is hunter two'),
          tts: new FakeTts(),
          turns: new FakeTurns({ message: [{ text: ['Your secret answer is purple.'] }] }),
        }),
    });
    await new Promise<void>(resolve => logServer.listen(0, '127.0.0.1', resolve));
    const address = logServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the test server has no port');
    }
    const { id } = voiceTickets.issue(TICKET);
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(address.port)}${VOICE_STREAM_PATH}`,
      [VOICE_SOCKET_PROTOCOL, `ticket.${id}`],
      { headers: { origin: PAGE } },
    );
    await new Promise(resolve => socket.on('open', resolve));
    const all = Int16Array.from([...hum(900), ...quiet(1200)]);
    for (let offset = 0; offset < all.length; offset += 512) {
      socket.send(pcmBytes(all.subarray(offset, offset + 512)));
      await new Promise(resolve => setTimeout(resolve, 8));
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    socket.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    const everything = logged.join('\n');
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of ['hunter two', 'purple', id]) {
      expect(everything).not.toContain(secret);
    }
    logServer.closeAllConnections();
    await new Promise<void>(resolve => {
      logServer.close(() => {
        resolve();
      });
    });
  }, 15_000);

  it('turns away a page from another site, and a connection that names no page', async () => {
    const { id } = voiceTickets.issue(TICKET);
    expect(await refused(open(id, { origin: 'https://evil.example' }))).toBe('403');
    const bare = new WebSocket(`ws://127.0.0.1:${String(port)}${VOICE_STREAM_PATH}`, [
      VOICE_SOCKET_PROTOCOL,
      `ticket.${id}`,
    ]);
    expect(await refused(bare)).toBe('403');
    // A refused page does not spend the ticket.
    const good = open(id);
    await new Promise(resolve => good.on('open', resolve));
    good.close();
  });

  it('carries audio in and the engine events and audio out, and ends on request', async () => {
    const { id } = voiceTickets.issue(TICKET);
    const socket = open(id);
    const texts: VoiceServerEvent[] = [];
    let audioFrames = 0;
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        audioFrames += 1;
      } else {
        // Every text frame must be one of the events the schema describes.
        texts.push(VoiceServerEventSchema.parse(JSON.parse(data.toString())));
      }
    });
    await new Promise(resolve => socket.on('open', resolve));
    expect(socket.protocol).toBe(VOICE_SOCKET_PROTOCOL);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(texts[0]).toEqual({ type: 'ready', sample_rate: 24000 });
    // Real time: the person talks for a second, then is quiet while the engine decides they are done.
    const all = Int16Array.from([...hum(900), ...quiet(1200)]);
    for (let offset = 0; offset < all.length; offset += 512) {
      socket.send(pcmBytes(all.subarray(offset, offset + 512)));
      await new Promise(resolve => setTimeout(resolve, 8));
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(texts).toContainEqual({ type: 'heard', text: 'what time is it' });
    expect(texts.some(message => message.type === 'turn_saved')).toBe(true);
    expect(audioFrames).toBeGreaterThan(0);
    const closed = new Promise<number>(resolve => socket.on('close', code => resolve(code)));
    socket.send(JSON.stringify({ type: 'end' }));
    expect(await closed).toBe(1000);
  }, 15_000);
});

describe('which page may open a voice line', () => {
  it.each([
    ['the public page', 'http://localhost:3000', [], true],
    ['a page behind a dev proxy', 'http://127.0.0.1:8790', [], true],
    ['a listed page', 'https://other.test', ['https://other.test'], true],
    ['another site', 'https://evil.test', [], false],
    ['a name that points at this computer (DNS rebinding)', 'http://evil.test:8790', [], false],
    ['no page at all', undefined, [], false],
    ['an unreadable page', 'not a url', [], false],
  ])('%s', (_name, origin, listed, expected) => {
    const pages = pageOrigins({ port: 8790, publicBaseUrl: 'http://localhost:3000', allowedOrigins: listed });
    expect(originAllowed({ origin, pages })).toBe(expected);
  });
});

describe('the turns a voice line runs', () => {
  it('go to the chat on the ticket, as the person on the ticket', async () => {
    const seen: { url: string; cookie: string | null }[] = [];
    const runner = turnRunnerFor({
      ticket: { ...TICKET, sessionId: 'chat-from-ticket' },
      selfFetch: request => {
        seen.push({ url: request.url, cookie: request.headers.get('cookie') });
        return new Response('{}');
      },
    });
    await runner.sendMessage({ text: 'hi', signal: new AbortController().signal, onText: () => undefined });
    expect(seen).toEqual([{ url: 'http://localhost/api/v1/sessions/chat-from-ticket/turns', cookie: 'session=abc' }]);
  });
});

describe("the voice WebSocket reaching the server's own routes behind the certificate check", () => {
  let server: Server;
  let port: number;
  let inner: number[];

  beforeEach(async () => {
    inner = [];
    server = createServer();
    attachVoiceSocket({
      server,
      app: mtlsApp(),
      pages: new Set([PAGE]),
      logger: winstonSilent(),
      requireClientCertificate: false,
      makeParts: async ({ ticket, selfFetch }) => {
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
    const { id } = voiceTickets.issue({ ...TICKET, headers: { cookie: 'user=u1', host: 'localhost' } });
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(port)}${VOICE_STREAM_PATH}`,
      [VOICE_SOCKET_PROTOCOL, `ticket.${id}`],
      { headers: { origin: PAGE } },
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
}): string {
  let listener: ((request: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined;
  attachVoiceSocket({
    server: {
      on: (_event, handler) => {
        listener = handler;
      },
    },
    app: mtlsApp(),
    pages: new Set([PAGE]),
    logger: winstonSilent(),
    requireClientCertificate,
  });
  const written: string[] = [];
  const raw = new Socket();
  raw.write = (chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  };
  raw.destroy = () => raw;
  const request = new IncomingMessage(connection);
  request.url = VOICE_STREAM_PATH;
  request.headers = { origin: PAGE, 'sec-websocket-protocol': VOICE_SOCKET_PROTOCOL };
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
