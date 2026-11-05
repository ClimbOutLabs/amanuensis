import { z } from '@hono/zod-openapi';

/**
 * Where a call Aman placed stands. `dialing` until Twilio names the call, `ringing` until it is answered, `connecting`
 * while a one-time media token waits to be used, `connected` while the line is open, and `ended` after.
 */
export const PhoneCallStatusSchema = z.enum(['dialing', 'ringing', 'connecting', 'connected', 'ended']);

/** How a call ended, in the words Activity uses. */
export const PhoneCallOutcomeSchema = z.enum(['answered', 'not_now', 'voicemail', 'no_answer', 'failed']);

/** What the open line is for: a conversation with the person, or a voicemail when a machine answered. */
export const PhoneCallModeSchema = z.enum(['talk', 'voicemail']);

/** Whether a call that is not answered falls back to one text and one push: `pending` until it has, `off` for a test. */
export const PhoneCallFallbackSchema = z.enum(['pending', 'done', 'off']);

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
  /** Approvals the call left waiting in the app. */
  follow_ups: z.number().int().min(0),
  created_at: z.string(),
  /** After this, Twilio's requests for the call are refused and no media session can open. */
  expires_at: z.string(),
  ended_at: z.string().nullable(),
});

export type PhoneCall = z.infer<typeof PhoneCallSchema>;
export type PhoneCallStatus = z.infer<typeof PhoneCallStatusSchema>;
export type PhoneCallOutcome = z.infer<typeof PhoneCallOutcomeSchema>;
export type PhoneCallMode = z.infer<typeof PhoneCallModeSchema>;
