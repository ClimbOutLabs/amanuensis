/** Reads a Gmail message into the plain fields the tools return. Mail text is data and is never interpreted here. */
import type { GmailMessage, MessagePart } from './gmailWire';
import { charsetOf, decodeBytes, decodeEncodedWords } from './mimeText';

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** A header's value with any RFC 2047 encoded words read in their own charset. */
export function headerOf(input: { message: GmailMessage; name: string }): string {
  const wanted = input.name.toLowerCase();
  const value = input.message.payload?.headers?.find(header => header.name.toLowerCase() === wanted)?.value ?? '';
  return decodeEncodedWords(value);
}

function partCharset(part: MessagePart): string | null {
  const contentType = part.headers?.find(header => header.name.toLowerCase() === 'content-type')?.value ?? '';
  return charsetOf(contentType);
}

function decodePart(input: { part: MessagePart; data: string }): string {
  const bytes = Uint8Array.from(Buffer.from(input.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  return decodeBytes({ bytes, charset: partCharset(input.part) });
}

/** Latin-1 supplement names (U+00A0 to U+00FF), in code point order, then the markup and punctuation ones. */
const LATIN1_ENTITY_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
    ' ',
  );

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  hellip: '\u2026',
  euro: '\u20ac',
  trade: '\u2122',
  bull: '\u2022',
  ...Object.fromEntries(LATIN1_ENTITY_NAMES.map((name, index) => [name, String.fromCodePoint(0xa0 + index)])),
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** A readable plain-text version of an HTML body: no scripts, styles or tags. */
export function htmlToText(html: string): string {
  const withoutBlocks = html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutBlocks.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collect(part: MessagePart, into: { plain: string[]; html: string[]; attachments: AttachmentInfo[] }): void {
  const attachmentId = part.body?.attachmentId;
  if (attachmentId !== undefined && part.filename !== undefined && part.filename !== '') {
    into.attachments.push({
      id: attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body?.size ?? 0,
    });
  } else if (part.body?.data !== undefined && (part.filename === undefined || part.filename === '')) {
    if (part.mimeType === 'text/plain') {
      into.plain.push(decodePart({ part, data: part.body.data }));
    } else if (part.mimeType === 'text/html') {
      into.html.push(decodePart({ part, data: part.body.data }));
    }
  }
  for (const child of part.parts ?? []) {
    collect(child, into);
  }
}

export interface ReadMessage {
  body: string;
  attachments: AttachmentInfo[];
}

/** The message text (plain text when the message has it, otherwise its HTML as text) and its attachments. */
export function readMessage(message: GmailMessage): ReadMessage {
  const found: { plain: string[]; html: string[]; attachments: AttachmentInfo[] } = {
    plain: [],
    html: [],
    attachments: [],
  };
  if (message.payload !== undefined) {
    collect(message.payload, found);
  }
  const body = found.plain.length > 0 ? found.plain.join('\n') : htmlToText(found.html.join('\n'));
  return { body: body.trim(), attachments: found.attachments };
}

export function labelIdsOf(message: GmailMessage): string[] {
  return message.labelIds ?? [];
}
