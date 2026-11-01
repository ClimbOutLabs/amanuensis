import { z } from '@hono/zod-openapi';

/** How loud a delivery is. A note only waits in the app; a nudge may also reach a device; a call is the loudest. */
export const DeliveryLevelSchema = z.enum(['note', 'nudge', 'call']).openapi('DeliveryLevel');

/** Where a delivery was tried. Later channels are added here; stored values are plain text. */
export const DeliveryChannelSchema = z.enum(['in_app', 'web_push']).openapi('DeliveryChannel');

export const DeliveryAttemptOutcomeSchema = z
  .enum(['sent', 'failed', 'gone', 'skipped'])
  .openapi('DeliveryAttemptOutcome');

export const DeliveryAttemptSchema = z
  .object({
    channel: DeliveryChannelSchema,
    outcome: DeliveryAttemptOutcomeSchema,
    detail: z.string().nullable().describe('A short plain-words note about the outcome, or null.'),
    target: z.string().nullable().describe('The device or address tried, or null for the app itself.'),
    attempted_at: z.string().describe('When the attempt was made, ISO 8601 UTC.'),
  })
  .openapi('DeliveryAttempt');

export const DeliveryChatLinkSchema = z
  .object({ type: z.literal('chat'), session_id: z.string().min(1) })
  .openapi('DeliveryChatLink');

export const DeliveryApprovalLinkSchema = z
  .object({ type: z.literal('approval'), session_id: z.string().min(1), approval_id: z.string().min(1) })
  .openapi('DeliveryApprovalLink');

export const DeliverySpaceLinkSchema = z
  .object({ type: z.literal('space'), space_id: z.string().min(1) })
  .openapi('DeliverySpaceLink');

export const DeliveryLinkSchema = z
  .discriminatedUnion('type', [DeliveryChatLinkSchema, DeliveryApprovalLinkSchema, DeliverySpaceLinkSchema])
  .openapi('DeliveryLink');

const TextSchema = z.string().min(1).max(2000);
const ReasonSchema = z.string().min(1).max(500);

/** Fields every kind carries. Left unnamed so each kind stays a flat object. */
const deliveryShape = {
  id: z.string().describe('Delivery id.'),
  level: DeliveryLevelSchema,
  text: TextSchema.describe('What the person reads.'),
  reason: ReasonSchema.describe('Why this reached the person, in plain words.'),
  created_at: z.string().describe('When the delivery was made, ISO 8601 UTC.'),
  seen_at: z.string().nullable().describe('When the person first saw it on any device, or null while unread.'),
  attempts: z.array(DeliveryAttemptSchema).describe('Each channel tried, oldest first.'),
};

export const ReminderDeliverySchema = z
  .object({ kind: z.literal('reminder'), link: DeliveryLinkSchema.nullable(), ...deliveryShape })
  .openapi('ReminderDelivery');

export const NoteDeliverySchema = z
  .object({ kind: z.literal('note'), link: DeliveryLinkSchema.nullable(), ...deliveryShape })
  .openapi('NoteDelivery');

export const NudgeDeliverySchema = z
  .object({ kind: z.literal('nudge'), link: DeliveryLinkSchema.nullable(), ...deliveryShape })
  .openapi('NudgeDelivery');

export const ApprovalWaitingDeliverySchema = z
  .object({ kind: z.literal('approval_waiting'), link: DeliveryApprovalLinkSchema, ...deliveryShape })
  .openapi('ApprovalWaitingDelivery');

/** Later parts add a member here; the stored `kind` is plain text, so no migration is needed. */
export const DeliverySchema = z
  .discriminatedUnion('kind', [
    ReminderDeliverySchema,
    NoteDeliverySchema,
    NudgeDeliverySchema,
    ApprovalWaitingDeliverySchema,
  ])
  .openapi('Delivery');

export const DeliveriesPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25).describe('Most items to return.'),
    page_token: z.string().optional().describe('Token from the previous page; omit for the newest items.'),
  })
  .openapi('ListDeliveriesRequestQuery');

export const ListDeliveriesResponseSchema = z
  .object({
    data: z.array(DeliverySchema).describe('Deliveries for the signed-in person, newest first.'),
    next_page_token: z.string().optional().describe('Pass as page_token to get older items; absent on the last page.'),
  })
  .openapi('ListDeliveriesResponse');

export const MarkDeliveriesSeenRequestSchema = z
  .object({ ids: z.array(z.string().min(1)).min(1).max(100).describe('Deliveries to mark seen.') })
  .openapi('MarkDeliveriesSeenRequest');

export const DeliveryUnreadCountSchema = z
  .object({ unread_count: z.number().int().min(0).describe('Deliveries not yet seen on any device.') })
  .openapi('DeliveryUnreadCount');

export const GetDeliveryUnreadCountResponseSchema = z
  .object({ data: DeliveryUnreadCountSchema })
  .openapi('GetDeliveryUnreadCountResponse');

export const GetDeliveryResponseSchema = z.object({ data: DeliverySchema }).openapi('GetDeliveryResponse');

export const DeliveryIdParamSchema = z
  .object({ delivery_id: z.string().min(1).describe('Delivery id.') })
  .openapi('DeliveryIdParam');

export const PushKeysSchema = z
  .object({
    p256dh: z.string().min(1).max(256).describe('The device public key, base64url.'),
    auth: z.string().min(1).max(256).describe('The device auth secret, base64url.'),
  })
  .openapi('PushKeys');

export const CreatePushSubscriptionRequestSchema = z
  .object({
    endpoint: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .describe('The push service address the browser gave this device. It must start with https.'),
    keys: PushKeysSchema,
    label: z.string().min(1).max(80).optional().describe('A short name for this device.'),
  })
  .openapi('CreatePushSubscriptionRequest');

export const PushSubscriptionSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    created_at: z.string().describe('When this device turned notices on, ISO 8601 UTC.'),
  })
  .openapi('PushSubscription');

export const GetPushSubscriptionResponseSchema = z
  .object({ data: PushSubscriptionSchema })
  .openapi('GetPushSubscriptionResponse');

export const DeletePushSubscriptionRequestQuerySchema = z
  .object({ endpoint: z.url().max(2048).describe('The push service address of the device to remove.') })
  .openapi('DeletePushSubscriptionRequestQuery');

export const DeletePushSubscriptionResponseSchema = z.object({}).openapi('DeletePushSubscriptionResponse');

export const PushConfigSchema = z
  .object({
    public_key: z.string().nullable().describe('The key a browser needs to turn notices on, or null when push is off.'),
  })
  .openapi('PushConfig');

export const GetPushConfigResponseSchema = z.object({ data: PushConfigSchema }).openapi('GetPushConfigResponse');

export type Delivery = z.infer<typeof DeliverySchema>;
export type DeliveryKind = Delivery['kind'];
export type DeliveryLevel = z.infer<typeof DeliveryLevelSchema>;
export type DeliveryChannel = z.infer<typeof DeliveryChannelSchema>;
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;
export type DeliveryAttemptOutcome = z.infer<typeof DeliveryAttemptOutcomeSchema>;
export type DeliveryLink = z.infer<typeof DeliveryLinkSchema>;
export type PushSubscriptionInfo = z.infer<typeof PushSubscriptionSchema>;
