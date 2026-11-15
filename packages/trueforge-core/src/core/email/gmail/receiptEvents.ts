/**
 * Host-written record of how a send ended: `aman.email.send_receipt`, a passthrough turn event (same mechanism
 * as `aman.skill.used`). The gate fills it only from what it verified, never from model text, and the chat
 * turns the approval card into a receipt from it, so it is stored with the turn and survives a reload.
 */
import { z } from '@hono/zod-openapi';
import { newEventId } from '../../events/schema';
import { SEND_RECEIPT_EVENT_TYPE, SendReceiptResultSchema, type SendReceiptResult } from './sendReceipt';

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
