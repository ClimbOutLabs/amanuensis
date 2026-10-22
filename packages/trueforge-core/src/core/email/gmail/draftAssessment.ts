/**
 * Decides whether a draft is one Aman can show in full and send exactly as shown. The send card and the review
 * hash cover the recipients, where replies go, the subject and the plain text. A draft with anything else that
 * changes what is delivered (an attachment, an HTML version, a header not listed here, a sender other than the
 * account) is refused, never sent on trust.
 */
import type { ReviewableDraft } from './draftReview';
import type { GmailMessage } from './gmailWire';
import { decodedHeaderOf, headerOf, headerOverflows, rawHeaderOf, readMessage } from './message';
import { MAX_REFERENCES, parseIdList } from './messageId';
import {
  countIdeographicSelectors,
  hasAmbiguousEncodedWord,
  hasHiddenCharacters,
  isPlainTextContentType,
  MAX_IDEOGRAPHIC_SELECTORS,
} from './mimeText';
import { addressListIsPlain, mailboxesIn, mailboxesOf } from './results';

/** Longest body a send card shows; anything longer is refused because no one reads it in full. */
const MAX_SENDABLE_BODY_CHARS = 20_000;

/**
 * The headers a sendable draft may carry. Anything else (a receipt request, a Content-Disposition) can change what
 * is delivered, so a draft with one is refused by name. Reply-To and Sender are checked against the account below.
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

/** An RFC 5322 date as mail clients and Gmail write it, without the optional zone comment. */
const DATE_PATTERN = String.raw`(?:[A-Z][a-z]{2}, )?\d{1,2} [A-Z][a-z]{2} \d{4} \d{1,2}:\d{2}(?::\d{2})? (?:[+-]\d{4}|[A-Z]{1,5})`;

const DATE_HEADER = new RegExp(String.raw`^${DATE_PATTERN}(?: \([A-Z]{2,5}\))? ?$`);

/**
 * Trace headers Gmail itself adds to a message created through its API, each allowed only as that exact stamp.
 * Any other value, another host or a second hop included, is refused by name like an unknown header.
 */
const GMAIL_TRACE_HEADERS = new Map([
  [
    'received',
    new RegExp(String.raw`^from \d{1,20} named unknown by gmailapi\.google\.com with HTTPREST; ${DATE_PATTERN}$`),
  ],
]);

/**
 * Headers Aman neither shows on the card nor decodes must be in a closed format that cannot carry text: an id
 * list, a version number, a date. Each is matched whole, with no spare space, no comment and nothing but
 * printable ASCII. Patterns have no overlapping quantifiers.
 */
const STRICT_HEADERS: Record<string, (value: string) => boolean> = {
  'in-reply-to': value => parseIdList({ value, max: MAX_REFERENCES }) !== null,
  references: value => parseIdList({ value, max: MAX_REFERENCES }) !== null,
  'message-id': value => parseIdList({ value, max: 1 }) !== null,
  'mime-version': value => value === '1.0',
  date: value => DATE_HEADER.test(value),
};

/** Headers that name an address other than the body's recipients; each is allowed only when it is the account. */
const ADDRESS_HEADERS = new Set(['reply-to', 'sender']);

/** The transfer encodings a reader decodes the same way. */
const TRANSFER_ENCODINGS = new Set(['7bit', '8bit', 'binary', 'quoted-printable', 'base64']);

/** Longest subject a send may have, so the card's header cap can never hide any of it. */
const MAX_SENDABLE_SUBJECT_CHARS = 300;

type DraftAssessment = { ok: true; draft: ReviewableDraft } | { ok: false; reason: string };

/**
 * The one address of a From header, or null when it is anything but `addr` or `Name <addr>`. Only the address
 * inside the angle brackets counts, so a display name that looks like another address decides nothing.
 */
const PLAIN_ASCII_ADDRESS = /^[!#-'*+\--9=?-Z^-~]+$/;

export function fromAddress(raw: string): string | null {
  const value = raw.trim();
  if (value.split('"').length % 2 === 0) {
    return null;
  }
  const opens = value.split('<').length - 1;
  const closes = value.split('>').length - 1;
  if (opens === 0 && closes === 0) {
    return PLAIN_ASCII_ADDRESS.test(value) ? value.toLowerCase() : null;
  }
  if (opens !== 1 || closes !== 1 || !value.endsWith('>')) {
    return null;
  }
  const inner = value.slice(value.indexOf('<') + 1, -1).trim();
  return PLAIN_ASCII_ADDRESS.test(inner) ? inner.toLowerCase() : null;
}

/**
 * The one address of a From, Reply-To or Sender header, or null unless it is a single plain mailbox. Read as a list
 * first, so an extra address before the brackets, a group or a comment cannot hide behind the account's own address.
 */
function singleMailboxAddress(raw: string): string | null {
  return addressListIsPlain(raw) && mailboxesOf(raw).length === 1 ? fromAddress(raw) : null;
}

const MAX_FROM_NAME_CHARS = 200;

/** The display name of a decoded From header, without its quotes; empty when there is none. */
function fromNameOf(decodedFrom: string): string {
  const open = decodedFrom.indexOf('<');
  const name = open === -1 ? '' : decodedFrom.slice(0, open).trim();
  return name.length >= 2 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
}

/** No leading whitespace and at most one closing newline: blank space at the edges would not show on the card. */
function hasOrdinaryEdges(body: string): boolean {
  const withoutClosingNewline = body.replace(/\r?\n$/, '');
  return withoutClosingNewline === withoutClosingNewline.trimEnd() && body === body.trimStart();
}

const REFUSALS = {
  formatting:
    'This draft has formatting or parts that Aman cannot show you in full, usually because it was edited in Gmail. Ask me to write it again.',
  format: 'This draft has a header that Aman cannot show you or check, so it cannot be sent. Ask me to write it again.',
  headers:
    'This draft lists a recipient in a form Aman cannot show you exactly, such as a group or a note in brackets. Ask me to write it again.',
  selectors:
    'This draft has more variation selectors than a name or word needs, and they do not show, so it cannot be sent. Ask me to write it again.',
  charset:
    'This draft uses a text encoding (such as UTF-7) that Aman cannot read for certain, so it cannot show you what would be sent. Ask me to write it again.',
  whitespace:
    'This draft starts with blank space or ends with more than one blank line, which would not show on the card. Ask me to write it again.',
  hidden:
    'This draft contains characters that do not show, so what you see would not be all of what is sent. Ask me to write it again.',
} as const;

/** A header name is shown only when it is a plain token, so a refusal never prints anything odd. */
function headerNameForDisplay(name: string): string {
  return /^[A-Za-z0-9-]{1,80}$/.test(name) ? ` (${name})` : '';
}

function unknownHeaderRefusal(name: string): string {
  return `This draft has a header Aman cannot check${headerNameForDisplay(name)}, so it was not sent. Ask Aman to write it again without it.`;
}

function notOneAddressRefusal(name: string): string {
  return `This draft's ${name} line is not one plain address, so Aman cannot show you exactly where it goes. Ask me to write it again.`;
}

const OTHER_SENDER_REFUSAL =
  'This draft says it is sent on behalf of another address (Sender), so it was not sent. Ask me to write it again from your own address.';

function repeatedHeaderRefusal(name: string): string {
  const shown = /^[A-Za-z0-9-]{1,80}$/.test(name) ? name : 'header';
  return `This draft has more than one ${shown} header, so Aman cannot tell what would be sent. Ask Aman to write it again.`;
}

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
    if (seen.has(name)) {
      return { ok: false, reason: repeatedHeaderRefusal(name) };
    }
    const isGmailStamp = GMAIL_TRACE_HEADERS.get(name)?.test(rawHeaderOf({ part: payload, name })) === true;
    if (!ALLOWED_HEADERS.has(name) && !ADDRESS_HEADERS.has(name) && !isGmailStamp) {
      return { ok: false, reason: unknownHeaderRefusal(header.name) };
    }
    seen.add(name);
  }
  const account = input.account.toLowerCase();
  let replyTo: string | null = null;
  for (const name of ADDRESS_HEADERS) {
    if (!seen.has(name)) {
      continue;
    }
    const shown = name === 'sender' ? 'Sender' : 'Reply-To';
    const address = singleMailboxAddress(rawHeaderOf({ part: payload, name }));
    if (address === null) {
      return { ok: false, reason: notOneAddressRefusal(shown) };
    }
    if (address === account) {
      continue;
    }
    // A Reply-To elsewhere is shown on the card before approval. A Sender elsewhere would send as someone else.
    if (name === 'sender') {
      return { ok: false, reason: OTHER_SENDER_REFUSAL };
    }
    replyTo = address;
  }
  // A change rewrites the draft from the call, which carries no reply address, so one kept here would be dropped.
  if (!input.forSend && replyTo !== null) {
    return {
      ok: false,
      reason:
        'This draft replies to another address, which Aman cannot keep when it changes a draft, so it was not changed. Ask Aman to write it again.',
    };
  }
  for (const [name, check] of Object.entries(STRICT_HEADERS)) {
    const value = rawHeaderOf({ part: payload, name });
    if (seen.has(name) && !check(value)) {
      return { ok: false, reason: REFUSALS.format };
    }
  }
  if (!isPlainTextContentType(rawHeaderOf({ part: payload, name: 'content-type' }))) {
    return { ok: false, reason: REFUSALS.charset };
  }
  const transferEncoding = rawHeaderOf({ part: payload, name: 'content-transfer-encoding' }).trim().toLowerCase();
  if (transferEncoding !== '' && !TRANSFER_ENCODINGS.has(transferEncoding)) {
    return { ok: false, reason: REFUSALS.formatting };
  }
  // Without a Reply-To, replies go to every From mailbox, so From must be exactly one too.
  const from = singleMailboxAddress(rawHeaderOf({ part: payload, name: 'from' }));
  if (from === null) {
    return { ok: false, reason: notOneAddressRefusal('From') };
  }
  if (from !== input.account.toLowerCase()) {
    return {
      ok: false,
      reason:
        'This draft is set to send from a different address than your Gmail account. Ask me to write it again from your own address.',
    };
  }
  for (const name of ['to', 'cc', 'bcc']) {
    if (!addressListIsPlain(rawHeaderOf({ part: payload, name }))) {
      return { ok: false, reason: REFUSALS.headers };
    }
  }
  if (
    read.charsetProblem ||
    ['From', 'Subject', 'To', 'Cc', 'Bcc'].some(name => hasAmbiguousEncodedWord(rawHeaderOf({ part: payload, name })))
  ) {
    return { ok: false, reason: REFUSALS.charset };
  }
  const decodedSubject = decodedHeaderOf({ message, name: 'Subject' });
  const selectors = [
    read.plainText,
    decodedSubject,
    ...['From', 'To', 'Cc', 'Bcc'].map(name => decodedHeaderOf({ message, name })),
  ]
    .map(countIdeographicSelectors)
    .reduce((sum, count) => sum + count, 0);
  if (selectors > MAX_IDEOGRAPHIC_SELECTORS) {
    return { ok: false, reason: REFUSALS.selectors };
  }
  const hiddenInHeaders = ['From', 'Subject', 'To', 'Cc', 'Bcc'].some(name =>
    hasHiddenCharacters(decodedHeaderOf({ message, name })),
  );
  if (hasHiddenCharacters(read.plainText) || hiddenInHeaders) {
    return { ok: false, reason: REFUSALS.hidden };
  }
  const fromName = fromNameOf(decodedHeaderOf({ message, name: 'From' }));
  const draft: ReviewableDraft = {
    to: mailboxesIn({ message, name: 'To' }),
    cc: mailboxesIn({ message, name: 'Cc' }),
    bcc: mailboxesIn({ message, name: 'Bcc' }),
    subject: headerOf({ message, name: 'Subject' }),
    body: read.plainText,
    threadId: message.threadId,
    inReplyTo: rawHeaderOf({ part: payload, name: 'in-reply-to' }),
    references: rawHeaderOf({ part: payload, name: 'references' }),
    fromName,
    // A saved draft's headers are delivered as Gmail holds them, names included, so none is left off.
    nameLeftOff: false,
    replyTo,
  };
  if (input.forSend) {
    if (
      ['From', 'Subject', 'To', 'Cc', 'Bcc'].some(
        name =>
          /[\r\n]/.test(rawHeaderOf({ part: payload, name })) || /[\r\n]/.test(decodedHeaderOf({ message, name })),
      ) ||
      fromName.length > MAX_FROM_NAME_CHARS
    ) {
      return { ok: false, reason: REFUSALS.format };
    }
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
    if (decodedSubject !== decodedSubject.trim() || !hasOrdinaryEdges(draft.body)) {
      return { ok: false, reason: REFUSALS.whitespace };
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
