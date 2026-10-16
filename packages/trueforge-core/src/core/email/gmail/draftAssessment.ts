/**
 * Decides whether a draft is one Aman can show in full and send exactly as shown. The send card and the review
 * hash cover the recipients, subject and plain text. A draft with anything else that changes what is delivered
 * (an attachment, an HTML version, a reply address, a different sender) is refused, never sent on trust.
 */
import type { ReviewableDraft } from './draftReview';
import type { GmailMessage } from './gmailWire';
import { headerOf, rawHeaderOf, readMessage } from './message';
import { addressesIn } from './results';

/** Longest body a send card shows; anything longer is refused because no one reads it in full. */
export const MAX_SENDABLE_BODY_CHARS = 20_000;

/** Headers that redirect replies, receipts or bounces, or change who is shown as the sender. */
const DELIVERY_HEADERS = [
  'reply-to',
  'sender',
  'return-path',
  'disposition-notification-to',
  'return-receipt-to',
  'errors-to',
  'resent-from',
  'resent-to',
  'resent-cc',
  'resent-bcc',
  'resent-sender',
];

export type DraftAssessment = { ok: true; draft: ReviewableDraft } | { ok: false; reason: string };

function bareAddress(value: string): string {
  return (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
}

/** What a draft would deliver, or why it cannot be shown and sent as it stands. */
export function assessDraft(input: { message: GmailMessage; account: string; forSend: boolean }): DraftAssessment {
  const { message } = input;
  const payload = message.payload;
  const read = readMessage(message);
  if (read.attachments.length > 0) {
    return {
      ok: false,
      reason: 'This draft has attachments, which Aman cannot show or send. Remove them in Gmail and ask again.',
    };
  }
  const singlePlainPart = payload?.mimeType === 'text/plain' && (payload.parts ?? []).length === 0;
  if (!singlePlainPart || read.hasHtml) {
    return {
      ok: false,
      reason:
        'This draft has formatting or parts that Aman cannot show you in full, usually because it was edited in Gmail. Ask me to write it again.',
    };
  }
  for (const name of DELIVERY_HEADERS) {
    if (rawHeaderOf({ part: payload, name }) !== '') {
      return {
        ok: false,
        reason: 'This draft sets a reply address or sender that Aman cannot show you. Ask me to write it again.',
      };
    }
  }
  const from = rawHeaderOf({ part: payload, name: 'from' });
  if (from !== '' && bareAddress(from) !== input.account.toLowerCase()) {
    return { ok: false, reason: 'This draft is set to send from a different address than your Gmail account.' };
  }
  const draft: ReviewableDraft = {
    to: addressesIn({ message, name: 'To' }),
    cc: addressesIn({ message, name: 'Cc' }),
    bcc: addressesIn({ message, name: 'Bcc' }),
    subject: headerOf({ message, name: 'Subject' }),
    body: read.body,
    threadId: message.threadId,
    inReplyTo: rawHeaderOf({ part: payload, name: 'in-reply-to' }),
  };
  if (input.forSend) {
    if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
      return { ok: false, reason: 'The draft has no recipients.' };
    }
    if (draft.body.length > MAX_SENDABLE_BODY_CHARS) {
      return {
        ok: false,
        reason: 'This draft is too long to show you in full, so it was not offered for sending. Ask me to shorten it.',
      };
    }
  }
  return { ok: true, draft };
}
