/**
 * Backend-to-sidecar speech-to-text. One recorded utterance per `POST /v1/transcribe`, which is the
 * sidecar's whole contract. Used by the upload route and by the voice session engine, so the two
 * always speak to the sidecar the same way. Transcripts are never logged.
 */
import { VoiceTranscriptionSchema } from '../schemas/voice';
import { wavFromSamples } from './audio';
import { speechSecretHeaders } from './speechSecret';
import { sttBaseUrl } from './sttAvailability';
import type { SpeechToText } from './transport';

/** Backend-to-sidecar forward timeout; the browser-side timeout is 65s. */
const STT_TRANSCRIBE_TIMEOUT_MS = 60_000;
/**
 * An immediate 503 (sidecar up but the model not warm yet) is retried this many
 * times, spaced STT_RETRY_DELAY_MS apart, for a retry budget under 10s, well
 * inside the 65s client timeout. Every other outcome, including a forward
 * timeout, fails immediately with no retry.
 */
const STT_TRANSCRIBE_MAX_ATTEMPTS = 3;
const STT_RETRY_DELAY_MS = 2_000;

/** Resolves after the given delay, or at once when the caller gives up; backs the bounded 503 retry backoff. */
function delay({ ms, signal }: { ms: number; signal: AbortSignal | undefined }): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * POSTs buffered audio to the sidecar's transcribe endpoint. Only immediate 503
 * responses are retried; a forward timeout or connection failure rejects and
 * the caller fails immediately with no retry.
 */
export async function forwardToSidecar(audio: Uint8Array, signal?: AbortSignal): Promise<Response> {
  const url = `${sttBaseUrl()}/v1/transcribe`;
  for (let attempt = 1; ; attempt += 1) {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', 'content-length': String(audio.byteLength), ...speechSecretHeaders() },
      body: audio,
      signal: AbortSignal.any([
        AbortSignal.timeout(STT_TRANSCRIBE_TIMEOUT_MS),
        ...(signal === undefined ? [] : [signal]),
      ]),
    });
    if (upstream.status !== 503 || attempt >= STT_TRANSCRIBE_MAX_ATTEMPTS) {
      return upstream;
    }
    await delay({ ms: STT_RETRY_DELAY_MS, signal });
    signal?.throwIfAborted();
  }
}

export class SidecarSpeechToText implements SpeechToText {
  async transcribe({ samples, signal }: { samples: Int16Array; signal: AbortSignal }): Promise<string> {
    const response = await forwardToSidecar(wavFromSamples(samples), signal);
    if (!response.ok) {
      throw new Error(`speech to text answered ${String(response.status)}`);
    }
    return VoiceTranscriptionSchema.parse(await response.json()).text;
  }
}
