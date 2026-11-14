/**
 * Canonical owner of the connection offer tool contract: the two tools a chat uses while offering
 * to connect a connector at the moment of need. The status tool reads whether one connector is
 * connected and whether the person has already turned its offer down. The decline tool records
 * that answer. Neither tool sees a password, an address, or any connector content.
 */
import { z } from 'zod';

export const CONNECTION_OFFER_SERVER_ID = 'connection_offer';

export const CONNECTION_OFFER_STATUS_TOOL_NAME = 'connection_offer_status';

export const RECORD_CONNECTION_OFFER_DECLINE_TOOL_NAME = 'record_connection_offer_decline';

/**
 * Both tools take one connector id. The host passes the ids of its own registry, so an id it does
 * not know never reaches a handler.
 */
export function connectionOfferInputSchema(connectorIds: readonly [string, ...string[]]) {
  return z.object({ connector: z.enum(connectorIds) }).strict();
}

/** The status read is the person's own connection state, so it is not open-world. */
export const CONNECTION_OFFER_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Recording the person's own no changes only that remembered choice; it reaches nothing outside. */
export const CONNECTION_OFFER_DECLINE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;
