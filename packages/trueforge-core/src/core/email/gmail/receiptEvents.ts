/**
 * Host-written record of how a send ended: `aman.email.send_receipt`, a passthrough turn event (same mechanism
 * as `aman.skill.used`). The gate fills it only from what it verified, never from model text, and the chat
 * turns the approval card into a receipt from it, so it is stored with the turn and survives a reload.
 */
import { z } from '@hono/zod-openapi';
import { newEventId } from '../../events/schema';

export const SEND_RECEIPT_EVENT_TYPE = 'aman.email.send_receipt' as const;

const NOT_SENT_REASONS = [
  'draft_changed',
  'needs_ok_again',
  'cannot_send',
  'gmail_refused',
  'reconnect_google',
  'rate_limited',
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
    to: z.array(z.string()).describe('Recipients, as the card showed them.'),
    cc: z.array(z.string()).describe('Copied recipients.'),
    bcc: z.array(z.string()).describe('Hidden copy recipients.'),
    subject: z.string().describe('Subject line.'),
    body: z.string().describe('The message text that was sent.'),
  })
  .openapi('SendReceiptMessage');

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

const SendReceiptResultSchema = z
  .discriminatedUnion('outcome', [SentResultSchema, NotSentResultSchema])
  .openapi('SendReceiptResult');

export type SendReceiptResult = z.infer<typeof SendReceiptResultSchema>;

/** Payload of the `aman.email.send_receipt` passthrough event. */
export const SendReceiptEventSchema = z
  .object({
    type: z.literal(SEND_RECEIPT_EVENT_TYPE).describe('Emitted when a send ends, sent or not.'),
    tool_call_id: z.string().describe('The send tool call whose approval card this answers.'),
    result: SendReceiptResultSchema,
  })
  .openapi('SendReceiptEvent');

export type SendReceiptEvent = z.infer<typeof SendReceiptEventSchema>;

/** Registers the event in the harness's passthrough registry; see `skillEvents.ts` for why it sits here. */
declare module '../../events/PassthroughEvents' {
  interface AgentPassthroughEventSchemaMap {
    'aman.email.send_receipt': typeof SendReceiptEventSchema;
  }
}

export type SendReceiptEventEnvelope = SendReceiptEvent & { id: string; created_at: string };

export function buildSendReceiptEvent(input: {
  tool_call_id: string;
  result: SendReceiptResult;
}): SendReceiptEventEnvelope {
  return {
    type: SEND_RECEIPT_EVENT_TYPE,
    id: newEventId(),
    created_at: new Date().toISOString(),
    tool_call_id: input.tool_call_id,
    result: input.result,
  };
}
