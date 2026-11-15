import { z } from '@hono/zod-openapi';

/** How much a text says. Private names only the kind of thing; full carries a reminder’s own words. */
export const TextModeSchema = z
  .enum(['private', 'full'])
  .describe('Private texts say only the kind of thing. Full texts carry a reminder’s own words.')
  .openapi('TextMode');

export type TextMode = z.infer<typeof TextModeSchema>;

/** A number in international form: a plus sign, a country code and 7 to 14 more digits. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * The person's number and the state of confirming it, one row per person. The code is kept only as a keyed hash.
 * Stored on SQLite and Postgres; never sent over the wire as is.
 */
export const TextContactSchema = z.object({
  phone: z.string().regex(E164_PATTERN),
  mode: TextModeSchema,
  /** When the person proved the number with a code. Null until then, and again after a STOP. */
  confirmed_at: z.string().nullable(),
  /** When the person replied STOP, or the phone company said they had. Null otherwise. */
  opted_out_at: z.string().nullable(),
  /** A new number the pending code went to. Texts keep going to `phone` until its code is confirmed. */
  pending_phone: z.string().regex(E164_PATTERN).nullable(),
  code_hash: z.string().nullable(),
  code_salt: z.string().nullable(),
  /** Which server key hashed the code, so a code from before the key changed reads as no code. */
  code_key_id: z.string().nullable(),
  code_expires_at: z.string().nullable(),
  code_attempts: z.number().int().min(0),
});

export type TextContact = z.infer<typeof TextContactSchema>;

/** The most words a person can let Aman text besides the common words. */
export const TEXT_WORDS_MAX = 200;

/** A word the person lets Aman text: letters only, as the word list holds them. */
const TextWordSchema = z.string().regex(/^[a-z]{2,24}$/);

/**
 * What an export carries: the number, the choice of words, and the words the person added. Nothing about confirming
 * the number travels. An export from before the added words has none.
 */
export const TextContactExportSchema = z.object({
  phone: z.string().regex(E164_PATTERN),
  mode: TextModeSchema,
  words: z.array(TextWordSchema).max(TEXT_WORDS_MAX).default([]),
});

export type TextContactExport = z.infer<typeof TextContactExportSchema>;

export const TextStatusSchema = z
  .object({
    phone: z.string().nullable().describe('The number the person entered, or null before one is entered.'),
    confirmed: z.boolean().describe('Whether the person proved the number with a code. Nothing is sent before then.'),
    mode: TextModeSchema,
    opted_out: z.boolean().describe('Whether the person replied STOP. They confirm the number again to use texts.'),
    pending_phone: z
      .string()
      .nullable()
      .describe('A new number waiting for its code. Texts keep going to the confirmed number until then.'),
    code_pending: z.boolean().describe('Whether a code was sent and can still be entered.'),
    private_preview: z.string().describe('What a Private text says, word for word, for a reminder.'),
    words: z
      .array(z.string())
      .describe('The words the person lets Aman text besides the common words, such as a name.'),
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

export const AddTextWordRequestSchema = z
  .object({
    word: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .describe('A name or word Aman may text, in letters only. A web ending or a number word is refused.'),
  })
  .openapi('AddTextWordRequest');

export const UpdateTextModeRequestSchema = z.object({ mode: TextModeSchema }).openapi('UpdateTextModeRequest');

export const DeleteTextNumberResponseSchema = z.object({}).openapi('DeleteTextNumberResponse');
