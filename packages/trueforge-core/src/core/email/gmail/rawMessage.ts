/** Builds the RFC 5322 message Gmail stores as a draft. Plain text only, always UTF-8. */
import type { DraftContent } from './toolContract';

/** The original message a reply answers: its RFC 5322 identifiers, which only Gmail's own ids lead to. */
export interface ReplyTarget {
  messageIdHeader: string;
  referencesHeader: string;
}

/** The fields of a draft as written, after any reply threading has been decided. */
export type RawDraftContent = Pick<DraftContent, 'to' | 'cc' | 'bcc' | 'subject' | 'body'>;

/** Longest encoded word in bytes of text: base64 makes 60 characters, plus 12 of framing, under the 75 limit. */
const MAX_WORD_BYTES = 45;

/** A header value on one line: folded lines are joined, and any line break that remains is refused. */
function singleLine(input: { value: string; field: string }): string {
  const unfolded = input.value.replace(/\r?\n[ \t]+/g, ' ');
  if (/[\r\n]/.test(unfolded)) {
    throw new RangeError(`The ${input.field} cannot contain line breaks.`);
  }
  return unfolded;
}

/** Non-ASCII header text as RFC 2047 encoded words of at most 45 bytes, never splitting a character. */
function encodeHeaderText(text: string): string {
  if (/^[ -~]*$/.test(text)) {
    return text;
  }
  const words: string[] = [];
  let current: number[] = [];
  for (const character of text) {
    const bytes = Buffer.from(character, 'utf8');
    if (current.length + bytes.length > MAX_WORD_BYTES) {
      words.push(Buffer.from(current).toString('base64'));
      current = [];
    }
    current.push(...bytes);
  }
  words.push(Buffer.from(current).toString('base64'));
  return words.map(word => `=?UTF-8?B?${word}?=`).join('\r\n ');
}

function wrapBase64(text: string): string {
  return (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');
}

/** An RFC 5322 message id list such as `<a@b> <c@d>`; anything else is dropped rather than copied into a header. */
function messageIds(value: string): string[] {
  return singleLine({ value, field: 'reply headers' }).match(/<[^<>\s]{1,300}>/g) ?? [];
}

/** `Re: <original subject>` without stacking prefixes. */
export function replySubject(original: string): string {
  // The subject is already cut to a short length; a loop keeps this free of nested quantifiers.
  let base = original.trim();
  while (/^re\s*:/i.test(base)) {
    base = base.slice(base.indexOf(':') + 1).trim();
  }
  return `Re: ${base}`;
}

/** The base64url `raw` field Gmail's drafts API takes. Throws a RangeError on a line break in any header field. */
export function buildRawMessage(input: { content: RawDraftContent; reply: ReplyTarget | undefined }): string {
  const { content } = input;
  const subject = singleLine({ value: content.subject, field: 'subject' });
  const replyId = input.reply === undefined ? '' : messageIds(input.reply.messageIdHeader).join(' ');
  const references =
    input.reply === undefined
      ? ''
      : [...new Set([...messageIds(input.reply.referencesHeader), ...messageIds(input.reply.messageIdHeader)])].join(
          ' ',
        );
  const headers = [
    `To: ${content.to.join(', ')}`,
    ...(content.cc === undefined || content.cc.length === 0 ? [] : [`Cc: ${content.cc.join(', ')}`]),
    ...(content.bcc === undefined || content.bcc.length === 0 ? [] : [`Bcc: ${content.bcc.join(', ')}`]),
    `Subject: ${encodeHeaderText(subject)}`,
    ...(replyId === '' ? [] : [`In-Reply-To: ${replyId}`, `References: ${references}`]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  for (const header of headers) {
    singleLine({ value: header.replace(/\r\n /g, ' '), field: 'message headers' });
  }
  const message = `${headers.join('\r\n')}\r\n\r\n${wrapBase64(content.body)}\r\n`;
  return Buffer.from(message, 'utf8').toString('base64url');
}
