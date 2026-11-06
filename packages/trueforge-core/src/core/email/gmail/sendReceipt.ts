/**
 * What a send receipt says: how a send ended and, when it went, the message the gate verified. Kept apart from
 * the event module so the chat can read the same reasons and shapes without the server's event registry.
 */
import { z } from '@hono/zod-openapi';
import { Tier3MailboxSchema } from '../../permissions/tierMailbox.js';

export const SEND_RECEIPT_EVENT_TYPE = 'aman.email.send_receipt' as const;

export const NOT_SENT_REASONS = [
  'draft_changed',
  'needs_ok_again',
  'cannot_send',
  'gmail_refused',
  'reconnect_google',
  'rate_limited',
  'demo_limited',
  'unconfirmed',
] as const;

const NotSentReasonSchema = z
  .enum(NOT_SENT_REASONS)
  .describe(
    'Why nothing was sent. unconfirmed: Gmail did not answer, so the message may have gone through; the Sent folder says.',
  )
  .openapi('NotSentReason');

export type NotSentReason = z.infer<typeof NotSentReasonSchema>;

const SendReceiptMessageSchema = z
  .object({
    to: z.array(Tier3MailboxSchema).describe('Recipients, as the card showed them.'),
    cc: z.array(Tier3MailboxSchema).describe('Copied recipients.'),
    bcc: z.array(Tier3MailboxSchema).describe('Hidden copy recipients.'),
    subject: z.string().describe('Subject line.'),
    body: z.string().describe('The message text that was sent.'),
    reply_to: z.string().nullable().describe('The address replies go to when it is not the sender, or null.'),
  })
  .openapi('SendReceiptMessage');

export type SendReceiptMessage = z.infer<typeof SendReceiptMessageSchema>;

const SentResultSchema = z
  .object({
    outcome: z.literal('sent'),
    sent_at: z.string().describe('ISO 8601 time Gmail accepted the send.'),
    sent_message_id: z.string().describe('Id of the message Gmail sent.'),
    check_code: z.string().describe('The code the approval card showed.'),
    message: SendReceiptMessageSchema,
  })
  .openapi('SendReceiptSent');

const NotSentResultSchema = z
  .object({
    outcome: z.literal('not_sent'),
    reason: NotSentReasonSchema,
  })
  .openapi('SendReceiptNotSent');

export const SendReceiptResultSchema = z
  .discriminatedUnion('outcome', [SentResultSchema, NotSentResultSchema])
  .openapi('SendReceiptResult');

export type SendReceiptResult = z.infer<typeof SendReceiptResultSchema>;
