/**
 * Decides whether a draft is one Aman can show in full and send exactly as shown. The send card and the review
 * hash cover the recipients, subject and plain text. A draft with anything else that changes what is delivered
 * (an attachment, an HTML version, a reply address, a different sender) is refused, never sent on trust.
 */
import type { ReviewableDraft } from './draftReview';
import type { GmailMessage } from './gmailWire';
import { decodedHeaderOf, headerOf, headerOverflows, rawHeaderOf, readMessage } from './message';
import { hasHiddenCharacters } from './mimeText';
import { addressesIn, addressListIsPlain } from './results';

/** Longest body a send card shows; anything longer is refused because no one reads it in full. */
export const MAX_SENDABLE_BODY_CHARS = 20_000;

/**
 * The only headers a sendable draft may carry. Anything else (a Reply-To, a Sender, a receipt request, a
 * Content-Disposition) can change who gets the message or what it is, so a draft with one is refused.
 */
const ALLOWED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
]);

/** Longest subject a send may have, so the card's header cap can never hide any of it. */
const MAX_SENDABLE_SUBJECT_CHARS = 300;

export type DraftAssessment = { ok: true; draft: ReviewableDraft } | { ok: false; reason: string };

/**
 * The one address of a From header, or null when it is anything but `addr` or `Name <addr>`. Only the address
 * inside the angle brackets counts, so a display name that looks like another address decides nothing.
 */
function fromAddress(raw: string): string | null {
  const value = raw.trim();
  if (value.split('"').length % 2 === 0) {
    return null;
  }
  const opens = value.split('<').length - 1;
  const closes = value.split('>').length - 1;
  if (opens === 0 && closes === 0) {
    return /^[^\s,;"<>()]+$/.test(value) ? value.toLowerCase() : null;
  }
  if (opens !== 1 || closes !== 1 || !value.endsWith('>')) {
    return null;
  }
  const inner = value.slice(value.indexOf('<') + 1, -1).trim();
  return /^[^\s,;"<>()]+$/.test(inner) ? inner.toLowerCase() : null;
}

const REFUSALS = {
  formatting:
    'This draft has formatting or parts that Aman cannot show you in full, usually because it was edited in Gmail. Ask me to write it again.',
  headers:
    'This draft sets headers that Aman cannot show you, such as a reply address or sender. Ask me to write it again.',
  hidden:
    'This draft contains characters that do not show, so what you see would not be all of what is sent. Ask me to write it again.',
} as const;

/** What a draft would deliver, or why it cannot be shown and sent as it stands. */
export function assessDraft(input: { message: GmailMessage; account: string; forSend: boolean }): DraftAssessment {
  const { message } = input;
  const payload = message.payload;
  const read = readMessage(message);
  if (read.attachments.length > 0 || (payload?.filename ?? '') !== '') {
    return {
      ok: false,
      reason: 'This draft has attachments, which Aman cannot show or send. Remove them in Gmail and ask again.',
    };
  }
  const singlePlainPart = payload?.mimeType === 'text/plain' && (payload.parts ?? []).length === 0;
  if (payload === undefined || !singlePlainPart || read.hasHtml) {
    return { ok: false, reason: REFUSALS.formatting };
  }
  if (headerOverflows(payload)) {
    return { ok: false, reason: REFUSALS.formatting };
  }
  const seen = new Set<string>();
  for (const header of payload.headers ?? []) {
    const name = header.name.toLowerCase();
    if (!ALLOWED_HEADERS.has(name) || seen.has(name)) {
      return { ok: false, reason: REFUSALS.headers };
    }
    seen.add(name);
  }
  const from = fromAddress(rawHeaderOf({ part: payload, name: 'from' }));
  if (from !== input.account.toLowerCase()) {
    return { ok: false, reason: 'This draft is set to send from a different address than your Gmail account.' };
  }
  for (const name of ['to', 'cc', 'bcc']) {
    if (!addressListIsPlain(rawHeaderOf({ part: payload, name }))) {
      return { ok: false, reason: REFUSALS.headers };
    }
  }
  const decodedSubject = decodedHeaderOf({ message, name: 'Subject' });
  const hiddenInHeaders = ['Subject', 'To', 'Cc', 'Bcc'].some(name =>
    hasHiddenCharacters(decodedHeaderOf({ message, name })),
  );
  if (read.hadHiddenText || hiddenInHeaders) {
    return { ok: false, reason: REFUSALS.hidden };
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
    if (decodedSubject.length > MAX_SENDABLE_SUBJECT_CHARS) {
      return {
        ok: false,
        reason:
          'This draft has a subject too long to show you in full, so it was not offered for sending. Ask me to shorten it.',
      };
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
