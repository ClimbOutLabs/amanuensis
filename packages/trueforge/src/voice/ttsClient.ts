/**
 * Backend-to-sidecar text-to-speech, streaming: one sentence in, audio out as it is made.
 * Text is never logged.
 */
import type { ReadableStreamReadResult } from 'node:stream/web';

import configuration from '../config';
import type { OutputFormat } from './audio';
import type { SpeechSynthesizer } from './transport';

const TTS_STREAM_TIMEOUT_MS = 60_000;

export function ttsBaseUrl(): string {
  return configuration.TTS_URL.replace(/\/+$/, '');
}

export class SidecarSpeechSynthesizer implements SpeechSynthesizer {
  readonly #voice: string | undefined;

  constructor(options: { voice?: string | undefined } = {}) {
    this.#voice = options.voice;
  }

  async *stream({
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
    // A sentence with nothing to say aloud (a lone symbol) is skipped, not an error.
    if (response.status === 400) {
      return;
    }
    if (!response.ok || response.body === null) {
      throw new Error(`text to speech answered ${String(response.status)}`);
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const piece: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (piece.done) {
          return;
        }
        yield piece.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
