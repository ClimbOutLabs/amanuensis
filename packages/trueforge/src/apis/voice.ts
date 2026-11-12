/**
 * Voice endpoints (mounted at `/api/v1/voice`). The browser posts recorded audio
 * here; this router forwards the bytes to the `aman-stt` sidecar and returns the
 * transcript. Reply text posted to `/speak` goes to the `aman-tts` sidecar and comes
 * back as audio. The browser never talks to either sidecar directly.
 *
 * Privacy: transcripts and reply text are never logged. Only durations, byte and
 * character counts, and status codes reach the logs.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import type { Logger } from 'winston';

import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import { inProcessFetch } from '../http/tls';
import { connectVoiceRoute, getVoiceStatusRoute, speakVoiceRoute, transcribeVoiceRoute } from '../routes/voiceRoutes';
import {
  MAX_SPEAK_TEXT_CHARS,
  VoiceTranscriptionSchema,
  type VoiceStatus,
  type VoiceTranscription,
} from '../schemas/voice';
import { VOICE_SOCKET_PROTOCOL, VOICE_STREAM_PATH } from '../voice/browserTransport';
import { SpeechRateLimiter, speechLimiter as sharedSpeechLimiter } from '../voice/speechRateLimit';
import { isVoiceAvailable, probeSttHealth } from '../voice/sttAvailability';
import { forwardToSidecar } from '../voice/sttClient';
import { probeTtsHealth, ttsBaseUrl } from '../voice/ttsClient';
import { VadModelUnavailableError } from '../voice/vad/sileroVad';
import { FORWARDED_HEADERS, readyVadModel, requestAs, type VoiceApp } from '../voice/voiceSocket';
import { VoiceTicketsFullError, voiceTickets } from '../voice/voiceTickets';

export interface VoiceRouterDeps {
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
  /** This server's own app; voice mode calls it to check the chat is the person's. */
  app: VoiceApp;
  /** Defaults to a fresh per-process limiter; tests inject one with a small budget. */
  speechLimiter?: SpeechRateLimiter;
  /** How often one person may ask to open a voice line. */
  connectLimiter?: SpeechRateLimiter;
}

/**
 * Audio body ceiling: 30 MB. The sidecar only accepts 16 kHz mono 16-bit WAV at
 * 32,000 bytes per second, so this is also a duration cap of about 16 minutes,
 * with headroom over the 3 minute client-side recording cap. The cap is enforced
 * while streaming the body, before the full upload is buffered.
 */
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
/** Model label the sidecar serves; reported by /status while the probe succeeds. */
const STT_MODEL_LABEL = 'whisper-small-int8';
/**
 * Backend-to-sidecar speech timeout. The longest allowed text is a few minutes of
 * audio, which a 4-core CPU synthesizes well inside this.
 */
const TTS_SPEAK_TIMEOUT_MS = 120_000;

class AudioTooLargeError extends Error {
  constructor() {
    super(`Audio body exceeds the ${String(MAX_AUDIO_BYTES)} byte limit`);
  }
}

function errorJson<S extends 400 | 404 | 413 | 429 | 502 | 503>(
  c: Context,
  { status, message, code }: { status: S; message: string; code: string },
) {
  return c.json({ error: { message, code } }, status);
}

const TTS_UNAVAILABLE: { status: 503; message: string; code: string } = {
  status: 503,
  message: 'The voice on this computer is not available right now. Try again in a minute.',
  code: 'tts_unavailable',
};
const TTS_FAILED: { status: 502; message: string; code: string } = {
  status: 502,
  message: 'The voice on this computer could not read this reply. Try again.',
  code: 'tts_error',
};

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

/** Probes the sidecar health endpoint; any failure degrades to unavailable. */
async function probeStt(logger: Logger): Promise<VoiceStatus> {
  const healthy = await probeSttHealth({ logger });
  return healthy ? { stt_available: true, model: STT_MODEL_LABEL } : { stt_available: false, model: '' };
}

/** Voice router (mounted at `/api/v1/voice`). */
export function createVoiceRouter(deps: VoiceRouterDeps) {
  const getVoiceStatusHandler: RouteHandler<typeof getVoiceStatusRoute> = async c => {
    return c.json({ data: await probeStt(deps.logger) }, 200);
  };

  const transcribeVoiceHandler: RouteHandler<typeof transcribeVoiceRoute> = async c => {
    const started = performance.now();
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

    let upstream: Response;
    try {
      upstream = await forwardToSidecar(audio);
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

  const speechLimiter = deps.speechLimiter ?? sharedSpeechLimiter;
  const connectLimiter =
    deps.connectLimiter ?? new SpeechRateLimiter({ maxPerWindow: 10, maxInFlight: Number.POSITIVE_INFINITY });

  const speakVoiceHandler: RouteHandler<typeof speakVoiceRoute> = async c => {
    if (!configuration.TTS_ENABLED) {
      return errorJson(c, {
        status: 503,
        message: 'The voice on this computer is turned off. Turn the local voice on in the server settings.',
        code: 'tts_disabled',
      });
    }
    const { text, voice } = c.req.valid('json');
    if (text.length > MAX_SPEAK_TEXT_CHARS) {
      return errorJson(c, {
        status: 413,
        message: `This reply is too long to read aloud at once. Send at most ${String(MAX_SPEAK_TEXT_CHARS)} characters at a time.`,
        code: 'text_too_long',
      });
    }
    const { tenant_id, subject } = deps.resolveRequestContext(c);
    const permit = speechLimiter.acquire(`${tenant_id}:${subject.id}`);
    if (!permit.allowed) {
      deps.logger.info('voice speak rejected', { reason: 'rate_limited' });
      c.header('Retry-After', String(permit.retryAfterSeconds));
      return errorJson(c, {
        status: 429,
        message: 'Too many read-aloud requests. Wait a few seconds, then try again.',
        code: 'rate_limited',
      });
    }
    const started = performance.now();
    try {
      let upstream: Response;
      try {
        upstream = await fetch(`${ttsBaseUrl()}/v1/speak`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(voice === undefined ? { text } : { text, voice }),
          // A caller who stops listening stops the work too, so abandoned replies do not queue up.
          signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(TTS_SPEAK_TIMEOUT_MS)]),
        });
      } catch (error) {
        // Nobody reads this answer; only the log line matters.
        if (c.req.raw.signal.aborted) {
          deps.logger.info('voice speak cancelled by the caller');
          return errorJson(c, TTS_UNAVAILABLE);
        }
        deps.logger.warn('voice speak failed: sidecar unreachable', extractErrorLogFields(error));
        return errorJson(c, TTS_UNAVAILABLE);
      }
      if (upstream.status === 503) {
        deps.logger.info('voice speak failed', { reason: 'tts_not_warm' });
        return errorJson(c, TTS_UNAVAILABLE);
      }
      if (upstream.status === 429) {
        deps.logger.info('voice speak rejected', { reason: 'tts_busy' });
        c.header('Retry-After', upstream.headers.get('retry-after') ?? '2');
        return errorJson(c, {
          status: 429,
          message: 'The voice is busy reading something else. Wait a few seconds, then try again.',
          code: 'tts_busy',
        });
      }
      if (upstream.status === 413) {
        deps.logger.info('voice speak rejected', { reason: 'sidecar_too_long' });
        return errorJson(c, {
          status: 413,
          message: 'This text is too long to read aloud at once. Send a shorter piece.',
          code: 'text_too_long',
        });
      }
      if (upstream.status === 400) {
        deps.logger.info('voice speak rejected', { reason: 'sidecar_rejected', tts_status: upstream.status });
        return errorJson(c, {
          status: 400,
          message:
            'The voice could not read this text aloud. Send text with words in it, and leave out the voice to use the usual one.',
          code: 'bad_text',
        });
      }
      const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (!upstream.ok || contentType !== 'audio/wav') {
        deps.logger.warn('voice speak failed', { reason: 'tts_error', tts_status: upstream.status });
        return errorJson(c, TTS_FAILED);
      }
      let audio: ArrayBuffer;
      try {
        audio = await upstream.arrayBuffer();
      } catch (error) {
        deps.logger.warn('voice speak failed: audio cut off', extractErrorLogFields(error));
        return errorJson(c, TTS_FAILED);
      }
      deps.logger.info('voice speak', {
        duration_ms: Math.round(performance.now() - started),
        text_chars: text.length,
        audio_bytes: audio.byteLength,
      });
      return c.body(audio, 200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, no-store' });
    } finally {
      permit.release();
    }
  };

  /**
   * Asks to talk: checks voice mode can run and that the chat is the caller's, then hands out a ticket for
   * the WebSocket. The socket itself is not described in the API document.
   */
  const connectHandler: RouteHandler<typeof connectVoiceRoute> = async c => {
    if (!configuration.TTS_ENABLED) {
      return errorJson(c, {
        status: 503,
        message:
          'Voice mode is turned off on this computer. Ask whoever set up Aman to turn on the voice (the TTS_ENABLED setting), then try again.',
        code: 'voice_mode_off',
      });
    }
    const request = c.req.valid('json');
    const { tenant_id, subject } = deps.resolveRequestContext(c);
    // Counted per ask, not per open line: each ask costs a request to the chat and a model check.
    const permit = connectLimiter.acquire(`${tenant_id}:${subject.id}`);
    if (!permit.allowed) {
      c.header('Retry-After', String(permit.retryAfterSeconds));
      return errorJson(c, {
        status: 429,
        message: 'Voice mode was started too many times. Wait a few seconds, then try again.',
        code: 'rate_limited',
      });
    }
    permit.release();
    if (!isVoiceAvailable()) {
      return errorJson(c, {
        status: 503,
        message: 'Speech to text is not ready yet. Try again in a minute.',
        code: 'stt_unavailable',
      });
    }
    if (!(await probeTtsHealth())) {
      return errorJson(c, {
        status: 503,
        message: 'The voice on this computer is not ready yet. Try again in a minute.',
        code: 'tts_unavailable',
      });
    }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = c.req.header(name);
      if (value !== undefined) {
        headers[name] = value;
      }
    }
    const ticket = {
      tenantId: tenant_id,
      subjectId: subject.id,
      sessionId: request.session_id,
      headers,
      timezone: request.client_timezone,
      voice: request.voice,
    };
    // The chat's own route says whether this person may use it, so there is one rule for that.
    const owned = await requestAs({ ticket, selfFetch: inProcessFetch(deps.app) })(
      `/api/v1/sessions/${encodeURIComponent(request.session_id)}`,
      { method: 'GET' },
    );
    if (!owned.ok) {
      return errorJson(c, {
        status: 404,
        message: 'That chat could not be found. Reload the page, then try again.',
        code: 'chat_not_found',
      });
    }
    try {
      await readyVadModel();
    } catch (error) {
      deps.logger.warn('voice model unavailable', extractErrorLogFields(error));
      return errorJson(c, {
        status: 503,
        message:
          error instanceof VadModelUnavailableError
            ? error.message
            : 'Voice mode could not load its listening model. Restart Aman, then try again.',
        code: 'vad_unavailable',
      });
    }
    let issued: ReturnType<typeof voiceTickets.issue>;
    try {
      issued = voiceTickets.issue(ticket);
    } catch (error) {
      if (error instanceof VoiceTicketsFullError) {
        return errorJson(c, {
          status: 503,
          message: 'Voice mode is busy right now. Try again in a minute.',
          code: 'voice_busy',
        });
      }
      throw error;
    }
    return c.json(
      {
        data: {
          ticket: issued.id,
          expires_in_seconds: issued.expiresInSeconds,
          protocol: VOICE_SOCKET_PROTOCOL,
          path: VOICE_STREAM_PATH,
        },
      },
      200,
      { 'Cache-Control': 'private, no-store' },
    );
  };

  const router = new OpenAPIHono();
  router.openapi(connectVoiceRoute, connectHandler);
  router.openapi(transcribeVoiceRoute, transcribeVoiceHandler);
  router.openapi(speakVoiceRoute, speakVoiceHandler);
  router.openapi(getVoiceStatusRoute, getVoiceStatusHandler);
  return router;
}
