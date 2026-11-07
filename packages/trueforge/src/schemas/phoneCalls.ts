import { z } from '@hono/zod-openapi';

/**
 * Where a call Aman placed stands. `dialing` until Twilio names the call, `ringing` until it is answered, `connecting`
 * while a one-time media token waits to be used, `connected` while the line is open, and `ended` after.
 */
const PhoneCallStatusSchema = z.enum(['dialing', 'ringing', 'connecting', 'connected', 'ended']);

/** How a call ended, in the words Activity uses. */
const PhoneCallOutcomeSchema = z.enum(['answered', 'not_now', 'voicemail', 'no_answer', 'failed']);

/** What the open line is for: a conversation with the person, or a voicemail when a machine answered. */
const PhoneCallModeSchema = z.enum(['talk', 'voicemail']);

/** Whether a call that is not answered falls back to one text and one push: `pending` until it has, `off` for a test. */
const PhoneCallFallbackSchema = z.enum(['pending', 'done', 'off']);

/** One call Aman placed. Stored on SQLite and Postgres; never sent over the wire as is. */
export const PhoneCallSchema = z.object({
  id: z.string().min(1),
  tenant_id: z.string().min(1),
  created_by: z.string().min(1),
  delivery_id: z.string().min(1),
  /** Twilio's id for the call, once Twilio has given one. A media session must name this same call. */
  call_sid: z.string().nullable(),
  status: PhoneCallStatusSchema,
  outcome: PhoneCallOutcomeSchema.nullable(),
  mode: PhoneCallModeSchema.nullable(),
  /** The chat the conversation is written in, once the person said it was a good time. */
  session_id: z.string().nullable(),
  fallback: PhoneCallFallbackSchema,
  created_at: z.string(),
  /** After this, Twilio's requests for the call are refused and no media session can open. */
  expires_at: z.string(),
  ended_at: z.string().nullable(),
});

export type PhoneCall = z.infer<typeof PhoneCallSchema>;
export type PhoneCallOutcome = z.infer<typeof PhoneCallOutcomeSchema>;
export type PhoneCallMode = z.infer<typeof PhoneCallModeSchema>;

/** Twilio's id for a call. */
export const CallSidSchema = z.string().regex(/^CA[0-9a-fA-F]{32}$/);

/** What Twilio's voice webhook says about a call that was just answered. Other fields Twilio sends are not read. */
export const VoiceWebhookParamsSchema = z.object({
  AccountSid: z.string().min(1),
  CallSid: CallSidSchema,
  /** Who answered, as the phone company could tell; missing when it could not. */
  AnsweredBy: z
    .enum(['human', 'machine_start', 'machine_end_beep', 'machine_end_silence', 'machine_end_other', 'fax', 'unknown'])
    .optional(),
});

/** What Twilio's status webhook says about how a call stands. Other fields Twilio sends are not read. */
export const CallStatusParamsSchema = z.object({
  AccountSid: z.string().min(1),
  CallSid: CallSidSchema,
  CallStatus: z.enum([
    'queued',
    'initiated',
    'ringing',
    'in-progress',
    'completed',
    'busy',
    'no-answer',
    'failed',
    'canceled',
  ]),
});
