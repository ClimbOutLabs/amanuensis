/**
 * Canonical owner of the Google setup tool contract: the one read the chat makes while leading a person
 * through connecting Google. It reads the saved login's state only: no secret, no mail, no calendar content
 * ever passes through it, and it changes nothing.
 */
import { z } from 'zod';

export const GOOGLE_SETUP_SERVER_ID = 'google_setup';

export const GOOGLE_SETUP_STATUS_TOOL_NAME = 'google_setup_status';

export const GoogleSetupStatusSchema = z.object({}).strict();

/** The setup read is this user's own connection state, so it is not open-world. */
export const GOOGLE_SETUP_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
