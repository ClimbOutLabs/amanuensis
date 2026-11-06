/**
 * Backend-to-sidecar text-to-speech, streaming: one sentence in, audio out as it is made.
 * Text is never logged.
 */
import type { ReadableStreamReadResult } from 'node:stream/web';

import configuration from '../config';
import type { OutputFormat } from './audio';
import type { SpeechRateLimiter } from './speechRateLimit';
import type { SpeechSynthesizer } from './transport';

const TTS_STREAM_TIMEOUT_MS = 60_000;

export function ttsBaseUrl(): string {
  return configuration.TTS_URL.replace(/\/+$/, '');
}

const TTS_HEALTH_TIMEOUT_MS = 2_000;

/** True when the voice service answers and has its model loaded. */
export async function probeTtsHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${ttsBaseUrl()}/healthz`, { signal: AbortSignal.timeout(TTS_HEALTH_TIMEOUT_MS) });
    const body: unknown = response.ok ? await response.json() : undefined;
    return typeof body === 'object' && body !== null && 'model_loaded' in body && body.model_loaded === true;
  } catch {
    return false;
  }
}

/** The service's own reason for a 400 that is not a fault: the sentence has nothing to read aloud. */
async function saysNothingToSay(response: Response): Promise<boolean> {
  const body: unknown = await response.json().catch(() => undefined);
  const detail = typeof body === 'object' && body !== null && 'detail' in body ? body.detail : undefined;
  return typeof detail === 'string' && detail.includes('nothing to say');
}

/** Hands on only whole 16-bit samples, holding a trailing odd byte until the next piece arrives. */
export class WholeSamples {
  #held: number | undefined;

  push(piece: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(piece.length + (this.#held === undefined ? 0 : 1));
    let offset = 0;
    if (this.#held !== undefined) {
      bytes[0] = this.#held;
      offset = 1;
      this.#held = undefined;
    }
    bytes.set(piece, offset);
    if (bytes.length % 2 === 1) {
      this.#held = bytes[bytes.length - 1];
      return bytes.subarray(0, bytes.length - 1);
    }
    return bytes;
  }
}

/** How long a conversation waits for a free place before giving up on one sentence. */
const SHARE_WAIT_MS = 10_000;
const SHARE_POLL_MS = 100;

/** Waits for the person's share of the voice service, so a conversation and their read-aloud requests take turns. */
async function takeShare({
  limiter,
  person,
  signal,
}: {
  limiter: SpeechRateLimiter;
  person: string;
  signal: AbortSignal;
}): Promise<() => void> {
  const deadline = Date.now() + SHARE_WAIT_MS;
  for (;;) {
    const permit = limiter.acquireInFlight(person);
    if (permit.allowed) {
      return permit.release;
    }
    signal.throwIfAborted();
    if (Date.now() >= deadline) {
      throw new Error('the voice service is busy with other requests');
    }
    await new Promise(resolve => setTimeout(resolve, SHARE_POLL_MS));
  }
}

export class SidecarSpeechSynthesizer implements SpeechSynthesizer {
  readonly #voice: string | undefined;
  readonly #share: { limiter: SpeechRateLimiter; person: string } | undefined;

  constructor(options: { voice?: string | undefined; share?: { limiter: SpeechRateLimiter; person: string } } = {}) {
    this.#voice = options.voice;
    this.#share = options.share;
  }

  async *stream(args: { text: string; format: OutputFormat; signal: AbortSignal }): AsyncIterable<Uint8Array> {
    const release = this.#share === undefined ? undefined : await takeShare({ ...this.#share, signal: args.signal });
    try {
      yield* this.#stream(args);
    } finally {
      release?.();
    }
  }

  async *#stream({
    text,
    format,
    signal,
  }: {
    text: string;
    format: OutputFormat;
    signal: AbortSignal;
  }): AsyncIterable<Uint8Array> {
    const response = await fetch(`${ttsBaseUrl()}/v1/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        format,
        stream: true,
        ...(this.#voice === undefined ? {} : { voice: this.#voice }),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TTS_STREAM_TIMEOUT_MS)]),
    });
    // A sentence with nothing to say aloud (a lone symbol) is skipped; any other refusal is a real failure.
    if (response.status === 400 && (await saysNothingToSay(response))) {
      return;
    }
    if (!response.ok || response.body === null) {
      throw new Error(`text to speech answered ${String(response.status)}`);
    }
    const reader = response.body.getReader();
    // A chunk can end in the middle of a 16-bit sample; the odd byte waits for the next chunk.
    const whole = format === 'pcm16' ? new WholeSamples() : undefined;
    try {
      for (;;) {
        const piece: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (piece.done) {
          return;
        }
        const out = whole === undefined ? piece.value : whole.push(piece.value);
        if (out.length > 0) {
          yield out;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
