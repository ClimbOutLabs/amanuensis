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

import { pageOrigins } from '../auth/requestGuard';
import configuration, { getAllowedOrigins, getPublicBaseUrl } from '../config';
import { hasAuthorizedClientCertificate, inProcessFetch } from '../http/tls';
import {
  BrowserVoiceTransport,
  readClientFrame,
  TICKET_PROTOCOL_PREFIX,
  VOICE_SOCKET_PROTOCOL,
  VOICE_STREAM_PATH,
} from './browserTransport';
import { VoiceSession, type VoiceSessionDeps } from './session';
import { speechLimiter } from './speechRateLimit';
import { SidecarSpeechToText } from './sttClient';
import { SidecarSpeechSynthesizer } from './ttsClient';
import { HttpVoiceTurnRunner } from './turnRunner';
import { SileroSpeechProbability, verifiedVadModel } from './vad/sileroVad';
import { voiceTickets, type VoiceTicketClaims } from './voiceTickets';

/** A connection with no audio for this long is closed; the browser sends frames all the time while the mic is on. */
const IDLE_CLOSE_MS = 30_000;
/** Longest frame accepted: a few hundred milliseconds of audio at most. */
const MAX_FRAME_BYTES = 64 * 1024;

/** The headers a turn needs to be run as the same person: who they are, and where the page came from. */
export const FORWARDED_HEADERS = ['host', 'origin', 'cookie', 'authorization', 'sec-fetch-site', 'user-agent'] as const;

/** Runs a request against this server's own app, in this process. */
export type SelfFetch = ReturnType<typeof inProcessFetch>;

/** The server's own app. Voice always calls it through `inProcessFetch`, so the certificate check lets those calls in. */
export type VoiceApp = Parameters<typeof inProcessFetch>[0];

export function requestAs({ ticket, selfFetch }: { ticket: VoiceTicketClaims; selfFetch: SelfFetch }) {
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

let model: Promise<Uint8Array> | undefined;

/** The verified listening model, read once per process. A failure is not remembered, so a retry can work. */
export function readyVadModel(): Promise<Uint8Array> {
  model ??= verifiedVadModel({ dir: configuration.VOICE_VAD_MODEL_DIR }).catch((error: unknown) => {
    model = undefined;
    throw error;
  });
  return model;
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
  ticket: VoiceTicketClaims;
  selfFetch: SelfFetch;
}): Promise<SessionParts> {
  return {
    vad: await SileroSpeechProbability.load({ model: await readyVadModel() }),
    stt: new SidecarSpeechToText(),
    tts: new SidecarSpeechSynthesizer({
      voice: ticket.voice,
      share: { limiter: speechLimiter, person: `${ticket.tenantId}:${ticket.subjectId}` },
    }),
    turns: turnRunnerFor({ ticket, selfFetch }),
  };
}

/** Turns run in the chat the ticket was issued for, as the person who asked for it. */
export function turnRunnerFor({
  ticket,
  selfFetch,
}: {
  ticket: VoiceTicketClaims;
  selfFetch: SelfFetch;
}): HttpVoiceTurnRunner {
  return new HttpVoiceTurnRunner({
    request: requestAs({ ticket, selfFetch }),
    sessionId: ticket.sessionId,
    clientTimezone: ticket.timezone,
  });
}

/** Most voice conversations open at once on one server; each holds a listening model and a microphone stream. */
export const MAX_VOICE_SESSIONS = 20;

/**
 * The page that opens a voice line must be one of the origins the app itself accepts. The Host header is
 * not trusted: a page on a name that points at this computer sends its own name there (DNS rebinding).
 */
export function originAllowed({ origin, pages }: { origin: string | undefined; pages: ReadonlySet<string> }): boolean {
  if (origin === undefined) {
    return false;
  }
  try {
    return pages.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

/** One person who belongs to several tenants cannot take more than this many of the shared places. */
const MAX_SESSIONS_PER_SUBJECT = 3;

/** One open conversation. It is reserved before anything is awaited, so parallel upgrades cannot all get in. */
interface Slot {
  subjectId: string;
  closed: boolean;
  session: VoiceSession | undefined;
  replace(): Promise<void>;
}

export function attachVoiceSocket({
  server,
  app,
  logger,
  requireClientCertificate,
  makeParts = productionParts,
  pages = pageOrigins({
    port: configuration.PORT,
    publicBaseUrl: getPublicBaseUrl(),
    allowedOrigins: getAllowedOrigins(),
  }),
  maxSessions = MAX_VOICE_SESSIONS,
}: {
  server: UpgradeSource;
  app: VoiceApp;
  logger: Logger;
  /** True when the server runs with mutual TLS: only connections with a verified certificate may open a line. Required, so a new caller cannot leave it out. */
  requireClientCertificate: boolean;
  /** Tests give stand-ins; the server leaves this out. */
  makeParts?: typeof productionParts;
  pages?: ReadonlySet<string>;
  maxSessions?: number;
}): void {
  const selfFetch = inProcessFetch(app);
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: protocols => (protocols.has(VOICE_SOCKET_PROTOCOL) ? VOICE_SOCKET_PROTOCOL : false),
  });
  /** One voice conversation per person: a new one replaces the old. */
  const active = new Map<string, Slot>();

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== VOICE_STREAM_PATH) {
      return;
    }
    if (requireClientCertificate && !hasAuthorizedClientCertificate(request.socket)) {
      refuse(socket, '403 Forbidden');
      return;
    }
    if (!originAllowed({ origin: request.headers.origin, pages })) {
      refuse(socket, '403 Forbidden');
      return;
    }
    const id = ticketFromProtocols(request.headers['sec-websocket-protocol']);
    const ticket = id === undefined ? undefined : voiceTickets.redeem(id);
    if (ticket === undefined) {
      refuse(socket, '401 Unauthorized');
      return;
    }
    const key = `${ticket.tenantId}:${ticket.subjectId}`;
    const ofThisPerson = [...active.values()].filter(slot => slot.subjectId === ticket.subjectId).length;
    if (!active.has(key) && (active.size >= maxSessions || ofThisPerson >= MAX_SESSIONS_PER_SUBJECT)) {
      refuse(socket, '503 Service Unavailable');
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => {
      void run({ ws, ticket, key }).catch((error: unknown) => {
        logger.warn('voice session failed to start', extractErrorLogFields(error));
        ws.close(1011, 'could not start');
      });
    });
  });

  async function run({ ws, ticket, key }: { ws: WebSocket; ticket: VoiceTicketClaims; key: string }): Promise<void> {
    const previous = active.get(key);
    const slot: Slot = {
      subjectId: ticket.subjectId,
      closed: false,
      session: undefined,
      replace: async () => {
        // Marked at once, so a model still loading for this socket is released when it arrives.
        slot.closed = true;
        ws.close(1000, 'replaced');
        await slot.session?.end();
      },
    };
    active.set(key, slot);
    // Attached before any await: a socket that closes while the model loads must still end what it started.
    let idle: ReturnType<typeof setTimeout> | undefined;
    ws.on('close', () => {
      slot.closed = true;
      clearTimeout(idle);
      if (active.get(key) === slot) {
        active.delete(key);
      }
      void slot.session?.end();
    });
    await previous?.replace();
    const transport = new BrowserVoiceTransport(ws);
    const parts = await makeParts({ ticket, selfFetch });
    if (slot.closed) {
      await parts.vad.dispose?.();
      return;
    }
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
    slot.session = session;
    transport.open();
    session.start();
    const restartIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        ws.close(1000, 'idle');
      }, IDLE_CLOSE_MS);
    };
    restartIdle();
    ws.on('message', (data, isBinary) => {
      restartIdle();
      const frame = readClientFrame({ data, isBinary });
      if (frame.kind === 'audio') {
        session.pushAudio(frame.bytes);
      } else if (frame.kind === 'end') {
        ws.close(1000, 'done');
      }
    });
  }
}
