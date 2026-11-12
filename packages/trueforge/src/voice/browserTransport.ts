/**
 * The browser's line to the voice engine: one WebSocket. The browser sends 16 kHz 16-bit samples as
 * binary frames and `{"type":"end"}` as text; the server sends 24 kHz 16-bit samples as binary
 * frames and the engine's events as JSON text. Wire keys are snake_case.
 */
import type { RawData, WebSocket } from 'ws';

import { VoiceClientMessageSchema, type VoiceServerEvent } from '@truefoundry/trueforge-core/schemas/voiceLine';
import { OUTPUT_SAMPLE_RATE } from './audio';
import type { VoiceEvent, VoiceTransport } from './transport';

/** Sub-protocol name that the browser asks for and the server answers with. */
export const VOICE_SOCKET_PROTOCOL = 'aman-voice.v1';
/** The browser sends the ticket as a second protocol: `ticket.<id>`, so it never appears in a URL. */
export const TICKET_PROTOCOL_PREFIX = 'ticket.';
export const VOICE_STREAM_PATH = '/api/v1/voice/stream';

export class BrowserVoiceTransport implements VoiceTransport {
  readonly outputFormat = 'pcm16';
  readonly inputFormat = 'pcm16_16k';
  readonly voiceApprovals = true;
  readonly #socket: WebSocket;

  constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  /** Tells the browser what rate the audio it receives is at. */
  open(): void {
    this.#sendJson({ type: 'ready', sample_rate: OUTPUT_SAMPLE_RATE.pcm16 });
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.#socket.readyState === this.#socket.OPEN) {
      this.#socket.send(chunk, { binary: true });
    }
  }

  clearAudio(): void {
    this.#sendJson({ type: 'clear' });
  }

  sendEvent(event: VoiceEvent): void {
    this.#sendJson(event);
  }

  close(): void {
    if (this.#socket.readyState === this.#socket.OPEN) {
      this.#socket.close(1000, 'done');
    }
  }

  #sendJson(message: VoiceServerEvent): void {
    if (this.#socket.readyState === this.#socket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }
}

function joined(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : data;
}

/** What a frame from the browser is: audio bytes, or the request to end. */
export function readClientFrame({
  data,
  isBinary,
}: {
  data: RawData;
  isBinary: boolean;
}): { kind: 'audio'; bytes: Uint8Array } | { kind: 'end' } | { kind: 'ignore' } {
  if (isBinary) {
    return { kind: 'audio', bytes: new Uint8Array(joined(data)) };
  }
  try {
    return VoiceClientMessageSchema.safeParse(JSON.parse(joined(data).toString())).success
      ? { kind: 'end' }
      : { kind: 'ignore' };
  } catch {
    return { kind: 'ignore' };
  }
}
