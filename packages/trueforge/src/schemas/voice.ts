/**
 * Wire schemas for the voice input endpoints (`POST /api/v1/voice/transcribe`,
 * `GET /api/v1/voice/status`). The transcription itself runs in the `aman-stt`
 * sidecar; these shapes are the agent backend's proxy contract with the browser.
 */
import { z } from '@hono/zod-openapi';

export const VoiceTranscriptionSchema = z
  .object({
    text: z
      .string()
      .max(20000)
      .describe('Transcribed utterance text.'),
    language: z.string().describe('Detected language code, e.g. `en`.'),
    duration_ms: z.number().int().nonnegative().describe('Sidecar transcription time in milliseconds.'),
    model: z.string().describe('STT model label, e.g. `whisper-small-int8`.'),
  })
  .openapi('VoiceTranscription');

export type VoiceTranscription = z.infer<typeof VoiceTranscriptionSchema>;

export const VoiceTranscriptionResponseSchema = z
  .object({
    data: VoiceTranscriptionSchema,
  })
  .openapi('VoiceTranscriptionResponse');

export type VoiceTranscriptionResponse = z.infer<typeof VoiceTranscriptionResponseSchema>;

export const VoiceStatusSchema = z
  .object({
    stt_available: z.boolean().describe('Whether the STT sidecar answered its health probe.'),
    model: z.string().describe('STT model label, empty when the sidecar is unreachable.'),
  })
  .openapi('VoiceStatus');

export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;

export const VoiceStatusResponseSchema = z
  .object({
    data: VoiceStatusSchema,
  })
  .openapi('VoiceStatusResponse');

export type VoiceStatusResponse = z.infer<typeof VoiceStatusResponseSchema>;
