/**
 * A phone line to the voice engine: Twilio Media Streams, two-way 8 kHz mu-law over one WebSocket. Twilio sends JSON
 * text frames (`connected`, `start`, `media`, `mark`, `stop`); audio is base64 in `media.payload`. The engine is
 * asked for mu-law, so what it makes is sent as it is.
 */
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';

import { socketBytes, type VoiceTransport } from './transport';

/** Longest wait for Twilio to say it has played everything sent, so a call never hangs open on a lost mark. */
const PLAYED_TIMEOUT_MS = 30_000;

const StartFrameSchema = z.object({
  event: z.literal('start'),
  start: z.object({
    streamSid: z.string().min(1),
    callSid: z.string().min(1),
    customParameters: z.record(z.string(), z.string()).optional(),
  }),
});
const MediaFrameSchema = z.object({
  event: z.literal('media'),
  media: z.object({ payload: z.string(), track: z.string().optional() }),
});
const MarkFrameSchema = z.object({ event: z.literal('mark'), mark: z.object({ name: z.string() }) });
const StopFrameSchema = z.object({ event: z.literal('stop') });
const ConnectedFrameSchema = z.object({ event: z.literal('connected') });

const TwilioFrameSchema = z.discriminatedUnion('event', [
  ConnectedFrameSchema,
  StartFrameSchema,
  MediaFrameSchema,
  MarkFrameSchema,
  StopFrameSchema,
]);

/** What a frame from Twilio means here; anything else is ignored. */
type PhoneFrame =
  | { kind: 'start'; streamSid: string; callSid: string; parameters: Record<string, string> }
  | { kind: 'audio'; bytes: Uint8Array }
  | { kind: 'mark'; name: string }
  | { kind: 'stop' }
  | { kind: 'ignore' };

export function readPhoneFrame(data: RawData): PhoneFrame {
  let message: unknown;
  try {
    message = JSON.parse(socketBytes(data).toString('utf8'));
  } catch {
    return { kind: 'ignore' };
  }
  const parsed = TwilioFrameSchema.safeParse(message);
  if (!parsed.success) {
    return { kind: 'ignore' };
  }
  const frame = parsed.data;
  switch (frame.event) {
    case 'start':
      return {
        kind: 'start',
        streamSid: frame.start.streamSid,
        callSid: frame.start.callSid,
        parameters: frame.start.customParameters ?? {},
      };
    case 'media':
      // Only the caller's side is listened to; Twilio sends the inbound track unless asked for more.
      return frame.media.track === undefined || frame.media.track === 'inbound'
        ? { kind: 'audio', bytes: new Uint8Array(Buffer.from(frame.media.payload, 'base64')) }
        : { kind: 'ignore' };
    case 'mark':
      return { kind: 'mark', name: frame.mark.name };
    case 'stop':
      return { kind: 'stop' };
    case 'connected':
      return { kind: 'ignore' };
  }
}

/** The parts of the socket the line uses. */
type PhoneSocket = Pick<WebSocket, 'OPEN' | 'readyState' | 'send' | 'close'>;

export class PhoneVoiceTransport implements VoiceTransport {
  readonly outputFormat = 'mulaw8k';
  readonly inputFormat = 'mulaw8k';
  /** The phone cannot tell who answered, so nothing is ever approved by voice on a call. */
  readonly voiceApprovals = false;
  readonly #socket: PhoneSocket;
  readonly #streamSid: string;
  readonly #marks = new Map<string, () => void>();
  #markCount = 0;

  constructor({ socket, streamSid }: { socket: PhoneSocket; streamSid: string }) {
    this.#socket = socket;
    this.#streamSid = streamSid;
  }

  sendAudio(chunk: Uint8Array): void {
    this.#send({
      event: 'media',
      streamSid: this.#streamSid,
      media: { payload: Buffer.from(chunk).toString('base64') },
    });
  }

  clearAudio(): void {
    this.#send({ event: 'clear', streamSid: this.#streamSid });
  }

  sendEvent(): void {
    // The phone has no screen, so the engine's events have nowhere to go.
  }

  close(): void {
    this.#settleMarks();
    if (this.#socket.readyState === this.#socket.OPEN) {
      // With the stream inside <Connect>, closing it ends the call: there is nothing after it to run.
      this.#socket.close(1000, 'done');
    }
  }

  /** Resolves once Twilio has played everything sent so far, or the line dropped, or it waited too long. */
  whenPlayed(): Promise<void> {
    if (this.#socket.readyState !== this.#socket.OPEN) {
      return Promise.resolve();
    }
    this.#markCount += 1;
    const name = `played-${String(this.#markCount)}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.#marks.delete(name);
        resolve();
      }, PLAYED_TIMEOUT_MS);
      this.#marks.set(name, () => {
        clearTimeout(timer);
        resolve();
      });
      this.#send({ event: 'mark', streamSid: this.#streamSid, mark: { name } });
    });
  }

  /** Twilio echoed a mark: what was sent before it has played, or was cleared. */
  onMark(name: string): void {
    const done = this.#marks.get(name);
    this.#marks.delete(name);
    done?.();
  }

  #settleMarks(): void {
    for (const done of this.#marks.values()) {
      done();
    }
    this.#marks.clear();
  }

  #send(message: object): void {
    if (this.#socket.readyState === this.#socket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }
}
