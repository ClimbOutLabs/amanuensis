/** Builds the RFC 5322 message Gmail stores as a draft. Plain text only, always UTF-8. */
import type { DraftContent } from './toolContract';

/** The original message a reply answers: its RFC 5322 identifiers, which only Gmail's own ids lead to. */
export interface ReplyTarget {
  messageIdHeader: string;
  referencesHeader: string;
}

function assertSingleLine(input: { value: string; field: string }): void {
  if (/[\r\n]/.test(input.value)) {
    throw new RangeError(`The ${input.field} cannot contain line breaks.`);
  }
}

/** Non-ASCII header text as one RFC 2047 encoded word per 40 characters, so no line passes 75 octets. */
function encodeHeaderText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) {
    return text;
  }
  const words: string[] = [];
  let current = '';
  for (const character of text) {
    if (Array.from(current).length >= 40) {
      words.push(current);
      current = '';
    }
    current += character;
  }
  words.push(current);
  return words.map(word => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function wrapBase64(text: string): string {
  return (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');
}

/** The base64url `raw` field Gmail's drafts API takes. Throws on a line break in any header field. */
export function buildRawMessage(input: { content: DraftContent; reply: ReplyTarget | undefined }): string {
  const { content } = input;
  assertSingleLine({ value: content.subject, field: 'subject' });
  const headers = [
    `To: ${content.to.join(', ')}`,
    ...(content.cc === undefined || content.cc.length === 0 ? [] : [`Cc: ${content.cc.join(', ')}`]),
    ...(content.bcc === undefined || content.bcc.length === 0 ? [] : [`Bcc: ${content.bcc.join(', ')}`]),
    `Subject: ${encodeHeaderText(content.subject)}`,
    ...(input.reply === undefined || input.reply.messageIdHeader === ''
      ? []
      : [
          `In-Reply-To: ${input.reply.messageIdHeader}`,
          `References: ${[input.reply.referencesHeader, input.reply.messageIdHeader].filter(part => part !== '').join(' ')}`,
        ]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  for (const header of headers) {
    assertSingleLine({ value: header.replace(/\r\n /g, ''), field: 'message headers' });
  }
  const message = `${headers.join('\r\n')}\r\n\r\n${wrapBase64(content.body)}\r\n`;
  return Buffer.from(message, 'utf8').toString('base64url');
}
