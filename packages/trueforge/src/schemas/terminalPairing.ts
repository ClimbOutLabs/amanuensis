import { z } from '@hono/zod-openapi';

/** Wire schemas for pairing a terminal and for the paired terminal keys. */

export const StartTerminalPairingRequestSchema = z
  .object({
    device_name: z
      .string()
      .min(1)
      .max(80)
      .describe('The name the terminal calls itself, shown to the person who confirms the pairing.'),
  })
  .openapi('StartTerminalPairingRequest');

export type StartTerminalPairingRequest = z.infer<typeof StartTerminalPairingRequestSchema>;

export const TerminalPairingStartSchema = z
  .object({
    pairing_id: z.string().describe('The id of this pairing, which the terminal gives back when it claims its key.'),
    code: z.string().describe('The one-time pairing code. It works once and expires a few minutes after it is issued.'),
    confirm_url: z.string().describe('The address the person opens in the web app to confirm this pairing.'),
    expires_at: z.string().describe('When the code stops working, as an ISO 8601 timestamp.'),
  })
  .openapi('TerminalPairingStart');

export const StartTerminalPairingResponseSchema = z
  .object({
    data: TerminalPairingStartSchema,
  })
  .openapi('StartTerminalPairingResponse');

export const ConfirmTerminalPairingRequestSchema = z
  .object({
    code: z.string().min(1).describe('The pairing code the terminal showed. Dashes and letter case do not matter.'),
  })
  .openapi('ConfirmTerminalPairingRequest');

export type ConfirmTerminalPairingRequest = z.infer<typeof ConfirmTerminalPairingRequestSchema>;

export const TerminalPairingConfirmationSchema = z
  .object({
    device_name: z.string().describe('The name of the terminal that was just paired.'),
    paired_at: z.string().describe('When the pairing was confirmed, as an ISO 8601 timestamp.'),
  })
  .openapi('TerminalPairingConfirmation');

export const ConfirmTerminalPairingResponseSchema = z
  .object({
    data: TerminalPairingConfirmationSchema,
  })
  .openapi('ConfirmTerminalPairingResponse');

export const LookupTerminalPairingRequestSchema = z
  .object({
    code: z.string().min(1).describe('The pairing code the terminal showed. Dashes and letter case do not matter.'),
  })
  .openapi('LookupTerminalPairingRequest');

export type LookupTerminalPairingRequest = z.infer<typeof LookupTerminalPairingRequestSchema>;

export const TerminalPairingLookupSchema = z
  .object({
    device_name: z.string().describe('The name of the terminal waiting on this pairing code.'),
  })
  .openapi('TerminalPairingLookup');

export const LookupTerminalPairingResponseSchema = z
  .object({
    data: TerminalPairingLookupSchema,
  })
  .openapi('LookupTerminalPairingResponse');

export const CompleteTerminalPairingRequestSchema = z
  .object({
    pairing_id: z.string().min(1).describe('The pairing id the start of this pairing returned.'),
    code: z.string().min(1).describe('The pairing code from the start of this pairing.'),
  })
  .openapi('CompleteTerminalPairingRequest');

export type CompleteTerminalPairingRequest = z.infer<typeof CompleteTerminalPairingRequestSchema>;

export const TerminalPairingCompletionSchema = z
  .object({
    status: z
      .enum(['waiting', 'paired'])
      .describe('`waiting` while nobody has confirmed yet, `paired` once the key is ready to claim.'),
    terminal_key: z
      .string()
      .optional()
      .describe('The terminal key, present only when the status is `paired`. It is given once and never stored.'),
    device_name: z.string().optional().describe('The paired terminal name, present only when the status is `paired`.'),
  })
  .openapi('TerminalPairingCompletion');

export const CompleteTerminalPairingResponseSchema = z
  .object({
    data: TerminalPairingCompletionSchema,
  })
  .openapi('CompleteTerminalPairingResponse');

export const TerminalKeyRevocationSchema = z
  .object({
    revoked: z.literal(true).describe('The key this request carried has been revoked.'),
  })
  .openapi('TerminalKeyRevocation');

export const RevokeCurrentTerminalKeyResponseSchema = z
  .object({
    data: TerminalKeyRevocationSchema,
  })
  .openapi('RevokeCurrentTerminalKeyResponse');

/** One paired terminal as the Settings list shows it. The key and its hash are never part of this. */
export const TerminalKeySchema = z
  .object({
    id: z.string().describe('The id of this terminal key.'),
    device_name: z.string().describe('The name the terminal was paired under.'),
    paired_at: z.string().describe('When the terminal was paired, as an ISO 8601 timestamp.'),
    last_used_at: z.string().describe('When the key last signed a request, as an ISO 8601 timestamp.'),
    revoked_at: z
      .string()
      .nullable()
      .describe('When the key was revoked, as an ISO 8601 timestamp, or null while the key is live.'),
  })
  .openapi('TerminalKey');

export type TerminalKey = z.infer<typeof TerminalKeySchema>;

export const GetTerminalKeysResponseSchema = z
  .object({
    data: z.array(TerminalKeySchema),
  })
  .openapi('GetTerminalKeysResponse');

export const TerminalKeyParamsSchema = z.object({
  terminal_key_id: z.string().min(1).describe('The id of the terminal key.'),
});

export const DeleteTerminalKeyResponseSchema = z.object({}).openapi('DeleteTerminalKeyResponse');
