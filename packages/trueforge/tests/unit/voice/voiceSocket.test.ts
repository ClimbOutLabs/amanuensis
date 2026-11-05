import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { winstonSilent } from './silentLogger';

import { VOICE_SOCKET_PROTOCOL, VOICE_STREAM_PATH } from '../../../src/voice/browserTransport';
import { attachVoiceSocket } from '../../../src/voice/voiceSocket';
import { VoiceTicketStore, voiceTickets, type VoiceTicket } from '../../../src/voice/voiceTickets';
import { FakeStt, FakeTts, FakeTurns, LoudnessVad, hum, pcmBytes, quiet } from '../../fixtures/voice/fakes';

const TICKET: VoiceTicket = {
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

  it('refuses an expired or unknown ticket', () => {
    let now = 0;
    const store = new VoiceTicketStore({ now: () => now });
    const { id } = store.issue(TICKET);
    now = 31_000;
    expect(store.redeem(id)).toBeUndefined();
    expect(store.redeem('never-issued')).toBeUndefined();
  });
});

describe('the voice WebSocket', () => {
  let server: Server;
  let port: number;
  let sentToApp: string[];

  beforeEach(async () => {
    sentToApp = [];
    server = createServer();
    attachVoiceSocket({
      server,
      logger: winstonSilent(),
      selfFetch: request => {
        sentToApp.push(request.url);
        return new Response('{}');
      },
      makeParts: () =>
        Promise.resolve({
          vad: new LoudnessVad(),
          stt: new FakeStt('what time is it'),
          tts: new FakeTts(),
          turns: new FakeTurns({ message: [{ text: ['It is nine o clock.'] }] }),
        }),
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  });

  function open(ticket: string | undefined): WebSocket {
    const protocols = ticket === undefined ? [VOICE_SOCKET_PROTOCOL] : [VOICE_SOCKET_PROTOCOL, `ticket.${ticket}`];
    return new WebSocket(`ws://127.0.0.1:${String(port)}${VOICE_STREAM_PATH}`, protocols);
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

  it('carries audio in and the engine events and audio out, and ends on request', async () => {
    const { id } = voiceTickets.issue(TICKET);
    const socket = open(id);
    const texts: Record<string, unknown>[] = [];
    let audioFrames = 0;
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        audioFrames += 1;
      } else {
        texts.push(JSON.parse(data.toString()) as Record<string, unknown>);
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
    expect(texts.some(message => message['type'] === 'turn_saved')).toBe(true);
    expect(audioFrames).toBeGreaterThan(0);
    const closed = new Promise<number>(resolve => socket.on('close', code => resolve(code)));
    socket.send(JSON.stringify({ type: 'end' }));
    expect(await closed).toBe(1000);
  }, 15_000);
});
