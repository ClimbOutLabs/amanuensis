/**
 * Canonical owner of the Email offer tool contract: the two tools the chat uses while offering to
 * connect email at the moment of need. The status tool reads whether any email route is connected
 * and whether the person has already turned the offer down. The decline tool records that answer.
 * Neither tool sees a password, an address, or any mail content.
 */
import { z } from 'zod';

export const EMAIL_OFFER_SERVER_ID = 'email_offer';

export const EMAIL_CONNECTION_STATUS_TOOL_NAME = 'email_connection_status';

export const RECORD_EMAIL_OFFER_DECLINE_TOOL_NAME = 'record_email_offer_decline';

export const EmailConnectionStatusSchema = z.object({}).strict();

export const RecordEmailOfferDeclineSchema = z.object({}).strict();

/** The status read is the person's own connection state, so it is not open-world. */
export const EMAIL_OFFER_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Recording the person's own no changes only that remembered choice; it reaches nothing outside. */
export const EMAIL_OFFER_DECLINE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;
