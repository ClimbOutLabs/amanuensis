/**
 * Backend-to-sidecar text-to-speech, streaming: one sentence in, audio out as it is made.
 * Text is never logged.
 */
import type { ReadableStreamReadResult } from 'node:stream/web';

import { z } from 'zod';

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

/** The service marks a 400 that is no fault with a header, not wording. */
function refusedFor({
  response,
  reason,
}: {
  response: Response;
  reason: 'nothing_to_say' | 'would_change_text';
}): boolean {
  return response.status === 400 && response.headers.get('x-aman-reason') === reason;
}

const TTS_NORMALIZE_TIMEOUT_MS = 5_000;

/** What the service answers when it would say the text as written; anything else is not the voice service. */
const NormalizeAnswerSchema = z.object({ spoken: z.string() });

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

export class SidecarSpeechSynthesizer implements SpeechSynthesizer {
  readonly #voice: string | undefined;
  readonly #share: { limiter: SpeechRateLimiter; person: string } | undefined;

  constructor(options: { voice?: string | undefined; share?: { limiter: SpeechRateLimiter; person: string } } = {}) {
    this.#voice = options.voice;
    this.#share = options.share;
  }

  async saysAsWritten({ text, signal }: { text: string; signal: AbortSignal }): Promise<boolean> {
    const response = await fetch(`${ttsBaseUrl()}/v1/normalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TTS_NORMALIZE_TIMEOUT_MS)]),
    });
    if (refusedFor({ response, reason: 'would_change_text' })) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`text to speech answered ${String(response.status)}`);
    }
    // A 200 from something else at this address must not pass for a yes.
    const answer = NormalizeAnswerSchema.safeParse(await response.json().catch(() => undefined));
    if (!answer.success) {
      throw new Error('text to speech answered 200 with something other than its words', { cause: answer.error });
    }
    return true;
  }

  async *stream(args: { text: string; format: OutputFormat; signal: AbortSignal }): AsyncIterable<Uint8Array> {
    const release =
      this.#share === undefined
        ? undefined
        : await this.#share.limiter.acquireInFlightWaiting({
            key: this.#share.person,
            signal: args.signal,
            timeoutMs: SHARE_WAIT_MS,
          });
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
    if (refusedFor({ response, reason: 'nothing_to_say' })) {
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
