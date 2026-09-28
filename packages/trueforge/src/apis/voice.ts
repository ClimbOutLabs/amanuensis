/**
 * Voice input endpoints (mounted at `/api/v1/voice`). The browser posts recorded
 * audio here; this router forwards the bytes to the `aman-stt` sidecar and returns
 * the transcript. The browser never talks to the sidecar directly.
 *
 * Privacy: transcripts are never logged. Only durations, byte counts, and status
 * codes reach the logs.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import type { Logger } from 'winston';

import configuration from '../config';
import { getVoiceStatusRoute, transcribeVoiceRoute } from '../routes/voiceRoutes';
import { VoiceTranscriptionSchema, type VoiceStatus, type VoiceTranscription } from '../schemas/voice';

export interface VoiceRouterDeps {
  logger: Logger;
}

/**
 * Audio body ceiling. The sidecar only accepts 16 kHz mono 16-bit WAV, which is
 * exactly 32,000 bytes per second, so this byte cap is also a duration cap:
 * 200 seconds, with headroom over the 180 second UI recording cap. Anything
 * larger cannot be a legitimate recording and is rejected before buffering.
 */
const MAX_AUDIO_BYTES = 200 * 16000 * 2;
const STT_TRANSCRIBE_TIMEOUT_MS = 120_000;
const STT_STATUS_TIMEOUT_MS = 2_000;
/** Model label the sidecar serves; reported by /status while the probe succeeds. */
const STT_MODEL_LABEL = 'whisper-small-int8';

class AudioTooLargeError extends Error {
  constructor() {
    super(`Audio body exceeds the ${String(MAX_AUDIO_BYTES)} byte limit`);
  }
}

function sttBaseUrl(): string {
  return configuration.STT_URL.replace(/\/+$/, '');
}

function errorJson(
  c: Context,
  { status, message, code }: { status: 400 | 413 | 502 | 503; message: string; code: string },
) {
  return c.json({ error: { message, code } }, status);
}

/** Reads the request body with an early 413, before buffering the whole upload. */
async function readBoundedAudio(c: Context): Promise<Uint8Array> {
  const declared = c.req.header('content-length');
  if (declared !== undefined) {
    const parsed = Number(declared);
    if (Number.isInteger(parsed) && parsed > MAX_AUDIO_BYTES) {
      throw new AudioTooLargeError();
    }
  }
  const body = c.req.raw.body;
  if (body == null) {
    return new Uint8Array(0);
  }
  const stream: ReadableStream<Uint8Array> = body;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_AUDIO_BYTES) {
      throw new AudioTooLargeError();
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Probes the sidecar health endpoint; any failure degrades to unavailable. */
async function probeStt(logger: Logger): Promise<VoiceStatus> {
  try {
    const response = await fetch(`${sttBaseUrl()}/healthz`, {
      signal: AbortSignal.timeout(STT_STATUS_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { stt_available: false, model: '' };
    }
    const body: unknown = await response.json();
    const modelLoaded = isRecord(body) && body['model_loaded'] === true;
    return modelLoaded ? { stt_available: true, model: STT_MODEL_LABEL } : { stt_available: false, model: '' };
  } catch (error) {
    logger.info('voice status probe failed', extractErrorLogFields(error));
    return { stt_available: false, model: '' };
  }
}

/** Voice input router (mounted at `/api/v1/voice`). */
export function createVoiceRouter(deps: VoiceRouterDeps) {
  const getVoiceStatusHandler: RouteHandler<typeof getVoiceStatusRoute> = async c => {
    return c.json({ data: await probeStt(deps.logger) }, 200);
  };

  const transcribeVoiceHandler: RouteHandler<typeof transcribeVoiceRoute> = async c => {
    const started = performance.now();
    const { language } = c.req.valid('query');
    const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (contentType !== 'audio/wav') {
      return errorJson(c, { status: 400, message: 'Content-Type must be audio/wav', code: 'bad_content_type' });
    }
    let audio: Uint8Array;
    try {
      audio = await readBoundedAudio(c);
    } catch (error) {
      if (error instanceof AudioTooLargeError) {
        deps.logger.info('voice transcribe rejected', { reason: 'audio_too_large' });
        return errorJson(c, { status: 413, message: error.message, code: 'audio_too_large' });
      }
      throw error;
    }
    if (audio.byteLength === 0) {
      return errorJson(c, { status: 400, message: 'Audio body is empty', code: 'empty_audio' });
    }

    const params = language !== undefined ? `?language=${encodeURIComponent(language)}` : '';
    let upstream: Response;
    try {
      upstream = await fetch(`${sttBaseUrl()}/v1/transcribe${params}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'content-length': String(audio.byteLength) },
        body: audio,
        signal: AbortSignal.timeout(STT_TRANSCRIBE_TIMEOUT_MS),
      });
    } catch (error) {
      deps.logger.warn('voice transcribe failed: sidecar unreachable', extractErrorLogFields(error));
      return errorJson(c, { status: 503, message: 'Speech transcription is unavailable', code: 'stt_unavailable' });
    }

    const durationMs = Math.round(performance.now() - started);
    if (upstream.status === 400 || upstream.status === 413) {
      deps.logger.info('voice transcribe rejected', {
        reason: 'sidecar_rejected',
        stt_status: upstream.status,
        audio_bytes: audio.byteLength,
      });
      return errorJson(c, {
        status: upstream.status,
        message: upstream.status === 413 ? 'Audio body is too large' : 'Audio could not be transcribed',
        code: 'bad_audio',
      });
    }
    if (upstream.status === 503) {
      deps.logger.info('voice transcribe failed', { reason: 'stt_not_warm' });
      return errorJson(c, { status: 503, message: 'Speech transcription is unavailable', code: 'stt_unavailable' });
    }
    if (!upstream.ok) {
      deps.logger.warn('voice transcribe failed', { reason: 'stt_error', stt_status: upstream.status });
      return errorJson(c, { status: 502, message: 'Speech transcription failed', code: 'stt_error' });
    }
    let transcription: VoiceTranscription;
    try {
      transcription = VoiceTranscriptionSchema.parse(await upstream.json());
    } catch (error) {
      deps.logger.warn('voice transcribe failed', {
        reason: 'stt_bad_response',
        ...extractErrorLogFields(error),
      });
      return errorJson(c, { status: 502, message: 'Speech transcription failed', code: 'stt_error' });
    }
    deps.logger.info('voice transcribe', {
      duration_ms: durationMs,
      audio_bytes: audio.byteLength,
      stt_status: upstream.status,
    });
    return c.json({ data: transcription }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(transcribeVoiceRoute, transcribeVoiceHandler);
  router.openapi(getVoiceStatusRoute, getVoiceStatusHandler);
  return router;
}
