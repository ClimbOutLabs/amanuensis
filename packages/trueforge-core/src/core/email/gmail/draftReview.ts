/**
 * What the user was shown before a send. The send card is built from the draft as Gmail holds it, and its hash
 * is part of the approved call, so an edit made after review, by anyone, voids the approval instead of mailing
 * different text.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../../permissions/approvalTokens';
import type { Tier3Mailbox } from '../../permissions/tierMailbox';

export interface ReviewableDraft {
  to: readonly Tier3Mailbox[];
  cc: readonly Tier3Mailbox[];
  bcc: readonly Tier3Mailbox[];
  subject: string;
  body: string;
  threadId: string;
  /** The `In-Reply-To` and `References` headers, so a change in threading counts as a change. */
  inReplyTo: string;
  references: string;
  /** The display name the message is sent under, which recipients see; empty when there is none. */
  fromName: string;
  /** Whether a recipient's name was left off because it looked like an address, so the card says so. */
  nameLeftOff: boolean;
}

/** Hash of everything a send delivers. */
export function hashDraft(draft: ReviewableDraft): string {
  return createHash('sha256').update(stableStringify(draft)).digest('hex');
}
