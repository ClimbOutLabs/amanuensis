/**
 * Wire schemas for the send-receipt passthrough event (`aman.email.send_receipt`).
 *
 * The bare event schema is owned by trueforge-core (`core/email/gmail/receiptEvents.ts`) because the Gmail
 * send gate produces it. This module adds the persisted form (flat, with the row's id and timestamp) and gives
 * it an `.openapi()` name, the same way `skillEvents.ts` does.
 */
import { z } from '@hono/zod-openapi';
import {
  SEND_RECEIPT_EVENT_TYPE,
  SendReceiptEventSchema,
  type SendReceiptEvent,
} from '@truefoundry/trueforge-core/core/email/gmail/receiptEvents';
import { EventIdSchema } from '@truefoundry/trueforge-core/core/events/schema';

export { SEND_RECEIPT_EVENT_TYPE, SendReceiptEventSchema };
export type { SendReceiptEvent };

export const SendReceiptPersistedEventSchema = z
  .object({
    ...SendReceiptEventSchema.shape,
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
  })
  .openapi('SendReceiptPersistedEvent');

export type SendReceiptPersistedEvent = z.infer<typeof SendReceiptPersistedEventSchema>;
