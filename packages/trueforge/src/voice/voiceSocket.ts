/**
 * Opens voice connections: the route that hands out a ticket, and the WebSocket upgrade that
 * redeems it and starts a voice session. Every turn is then run through the app's own turn route
 * with the person's own credentials, so sign-in, tenant scoping and approvals are the same as for a
 * typed message.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'winston';
import { WebSocketServer, type WebSocket } from 'ws';

import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';

import configuration from '../config';
import {
  BrowserVoiceTransport,
  readClientFrame,
  TICKET_PROTOCOL_PREFIX,
  VOICE_SOCKET_PROTOCOL,
  VOICE_STREAM_PATH,
} from './browserTransport';
import { VoiceSession, type VoiceSessionDeps } from './session';
import { SidecarSpeechToText } from './sttClient';
import { SidecarSpeechSynthesizer } from './ttsClient';
import { HttpVoiceTurnRunner } from './turnRunner';
import { ensureVadModel, SileroSpeechProbability } from './vad/sileroVad';
import { voiceTickets, type VoiceTicket } from './voiceTickets';

/** A connection with no audio for this long is closed; the browser sends frames all the time while the mic is on. */
const IDLE_CLOSE_MS = 30_000;
/** Longest frame accepted: a few hundred milliseconds of audio at most. */
const MAX_FRAME_BYTES = 64 * 1024;

/** The headers a turn needs to be run as the same person: who they are, and where the page came from. */
export const FORWARDED_HEADERS = ['host', 'origin', 'cookie', 'authorization', 'sec-fetch-site', 'user-agent'] as const;

/** Runs a request against this server's own app, in this process. */
export type SelfFetch = (request: Request) => Response | Promise<Response>;

export function requestAs({ ticket, selfFetch }: { ticket: VoiceTicket; selfFetch: SelfFetch }) {
  return (path: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(ticket.headers)) {
      headers.set(name, value);
    }
    const host = ticket.headers['host'] ?? `localhost:${String(configuration.PORT)}`;
    return Promise.resolve(selfFetch(new Request(`http://${host}${path}`, { ...init, headers })));
  };
}

function ticketFromProtocols(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const protocols = raw.split(',').map(value => value.trim());
  if (!protocols.includes(VOICE_SOCKET_PROTOCOL)) {
    return undefined;
  }
  return protocols.find(value => value.startsWith(TICKET_PROTOCOL_PREFIX))?.slice(TICKET_PROTOCOL_PREFIX.length);
}

function refuse(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

let modelPath: Promise<string> | undefined;

/** The verified listening model, downloaded once per process. A failure is not remembered, so a retry can work. */
export function readyVadModel(): Promise<string> {
  modelPath ??= ensureVadModel({ dir: configuration.VOICE_VAD_MODEL_DIR }).catch((error: unknown) => {
    modelPath = undefined;
    throw error;
  });
  return modelPath;
}

/** Anything that can tell us a client asked to upgrade its connection to a WebSocket. */
export interface UpgradeSource {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

/** The parts a session listens, thinks and speaks with. */
export type SessionParts = Pick<VoiceSessionDeps, 'vad' | 'stt' | 'tts' | 'turns'>;

export async function productionParts({
  ticket,
  selfFetch,
}: {
  ticket: VoiceTicket;
  selfFetch: SelfFetch;
}): Promise<SessionParts> {
  return {
    vad: await SileroSpeechProbability.load({ modelPath: await readyVadModel() }),
    stt: new SidecarSpeechToText(),
    tts: new SidecarSpeechSynthesizer({ voice: ticket.voice }),
    turns: new HttpVoiceTurnRunner({
      request: requestAs({ ticket, selfFetch }),
      sessionId: ticket.sessionId,
      clientTimezone: ticket.timezone,
    }),
  };
}

export function attachVoiceSocket({
  server,
  selfFetch,
  logger,
  makeParts = productionParts,
}: {
  server: UpgradeSource;
  selfFetch: SelfFetch;
  logger: Logger;
  /** Tests give stand-ins; the server leaves this out. */
  makeParts?: typeof productionParts;
}): void {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: protocols => (protocols.has(VOICE_SOCKET_PROTOCOL) ? VOICE_SOCKET_PROTOCOL : false),
  });
  /** One voice conversation per person: a new one replaces the old. */
  const active = new Map<string, VoiceSession>();

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== VOICE_STREAM_PATH) {
      return;
    }
    const id = ticketFromProtocols(request.headers['sec-websocket-protocol']);
    const ticket = id === undefined ? undefined : voiceTickets.redeem(id);
    if (ticket === undefined) {
      refuse(socket, '401 Unauthorized');
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => {
      void run({ ws, ticket }).catch((error: unknown) => {
        logger.warn('voice session failed to start', extractErrorLogFields(error));
        ws.close(1011, 'could not start');
      });
    });
  });

  async function run({ ws, ticket }: { ws: WebSocket; ticket: VoiceTicket }): Promise<void> {
    const transport = new BrowserVoiceTransport(ws);
    const parts = await makeParts({ ticket, selfFetch });
    const key = `${ticket.tenantId}:${ticket.subjectId}`;
    const session = new VoiceSession({
      ...parts,
      transport,
      // Timings and reason codes only: what was said is never logged.
      onLatency: latency => {
        logger.info('voice turn', latency);
      },
      onNote: note => {
        logger.info('voice note', { note });
      },
    });
    await active.get(key)?.end();
    active.set(key, session);
    transport.open();
    session.start();
    let idle = setTimeout(() => {
      ws.close(1000, 'idle');
    }, IDLE_CLOSE_MS);
    ws.on('message', (data, isBinary) => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        ws.close(1000, 'idle');
      }, IDLE_CLOSE_MS);
      const frame = readClientFrame({ data, isBinary });
      if (frame.kind === 'audio') {
        session.pushAudio(frame.bytes);
      } else if (frame.kind === 'end') {
        ws.close(1000, 'done');
      }
    });
    ws.on('close', () => {
      clearTimeout(idle);
      if (active.get(key) === session) {
        active.delete(key);
      }
      void session.end();
    });
  }
}
