import { z } from '@hono/zod-openapi';

/** How much a text says. Private names only the kind of thing; full carries the one-sentence message. */
export const TextModeSchema = z
  .enum(['private', 'full'])
  .describe('Private texts say only the kind of thing. Full texts carry the one-sentence message.')
  .openapi('TextMode');

export type TextMode = z.infer<typeof TextModeSchema>;

/** A number in international form: a plus sign, a country code and 7 to 14 more digits. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * The person's number and the state of confirming it, one row per person. The code is kept only as a salted hash.
 * Stored on SQLite and Postgres; never sent over the wire as is.
 */
export const TextContactSchema = z.object({
  phone: z.string().regex(E164_PATTERN),
  mode: TextModeSchema,
  /** When the person proved the number with a code. Null until then, and again after a STOP. */
  confirmed_at: z.string().nullable(),
  /** When the person replied STOP, or the phone company said they had. Null otherwise. */
  opted_out_at: z.string().nullable(),
  code_hash: z.string().nullable(),
  code_salt: z.string().nullable(),
  code_expires_at: z.string().nullable(),
  code_attempts: z.number().int().min(0),
  /** The start of the hour in which codes are counted, and how many were sent in it. */
  send_window_started_at: z.string().nullable(),
  sends_in_window: z.number().int().min(0),
});

export type TextContact = z.infer<typeof TextContactSchema>;

/** What an export carries: the number and the choice of words. Nothing about confirming it travels. */
export const TextContactExportSchema = z.object({ phone: z.string().regex(E164_PATTERN), mode: TextModeSchema });

export type TextContactExport = z.infer<typeof TextContactExportSchema>;

export const TextStatusSchema = z
  .object({
    phone: z.string().nullable().describe('The number the person entered, or null before one is entered.'),
    confirmed: z.boolean().describe('Whether the person proved the number with a code. Nothing is sent before then.'),
    mode: TextModeSchema,
    opted_out: z.boolean().describe('Whether the person replied STOP. They confirm the number again to use texts.'),
    code_pending: z.boolean().describe('Whether a code was sent and can still be entered.'),
  })
  .openapi('TextStatus');

export type TextStatus = z.infer<typeof TextStatusSchema>;

export const GetTextStatusResponseSchema = z.object({ data: TextStatusSchema }).openapi('GetTextStatusResponse');

export const SendTextCodeRequestSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .describe('The number to send a code to, with the country code, such as +15550100.'),
  })
  .openapi('SendTextCodeRequest');

export const ConfirmTextCodeRequestSchema = z
  .object({ code: z.string().trim().min(1).max(12).describe('The code that was texted.') })
  .openapi('ConfirmTextCodeRequest');

export const UpdateTextModeRequestSchema = z.object({ mode: TextModeSchema }).openapi('UpdateTextModeRequest');

export const DeleteTextNumberResponseSchema = z.object({}).openapi('DeleteTextNumberResponse');
