/**
 * Wire schemas for the voice endpoints (`POST /api/v1/voice/transcribe`, `POST /api/v1/voice/speak`,
 * `GET /api/v1/voice/status`). Transcription runs in the `aman-stt` sidecar and
 * speech in `aman-tts`; these shapes are the agent backend's proxy contract with the browser.
 */
import { z } from '@hono/zod-openapi';

export const VoiceTranscriptionSchema = z
  .object({
    text: z.string().describe('Transcribed utterance text.'),
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

/** Longest reply text one `POST /api/v1/voice/speak` call reads aloud; longer text gets 413. */
export const MAX_SPEAK_TEXT_CHARS = 4000;

export const SpeakVoiceRequestSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .describe(`Reply text to read aloud, up to ${String(MAX_SPEAK_TEXT_CHARS)} characters.`),
    voice: z.string().min(1).max(64).optional().describe('Voice id, e.g. `af_heart`. Omit for the default voice.'),
  })
  .openapi('SpeakVoiceRequest');

export type SpeakVoiceRequest = z.infer<typeof SpeakVoiceRequestSchema>;

export const ConnectVoiceRequestSchema = z
  .object({
    session_id: z.string().min(1).max(200).describe('The chat to talk in.'),
    voice: z
      .string()
      .regex(/^[a-z]{2}_[a-z]+$/)
      .optional()
      .describe('Voice id for spoken replies. Defaults to the server voice.'),
    client_timezone: z.string().min(1).max(100).optional().describe('IANA time zone of the person talking.'),
  })
  .openapi('ConnectVoiceRequest');
export type ConnectVoiceRequest = z.infer<typeof ConnectVoiceRequestSchema>;

export const VoiceTicketSchema = z
  .object({
    ticket: z.string().describe('Single-use ticket to open the voice line. Send it as the `ticket.<id>` sub-protocol.'),
    expires_in_seconds: z.number().int().describe('Seconds the ticket stays valid.'),
    protocol: z.string().describe('Sub-protocol name to ask for on the WebSocket.'),
    path: z.string().describe('WebSocket path to open on this server.'),
  })
  .openapi('VoiceTicket');

export type VoiceTicket = z.infer<typeof VoiceTicketSchema>;

export const VoiceTicketResponseSchema = z.object({ data: VoiceTicketSchema }).openapi('VoiceTicketResponse');
