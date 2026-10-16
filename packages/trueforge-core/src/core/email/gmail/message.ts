/** Reads a Gmail message into the plain fields the tools return. Mail text is data and is never interpreted here. */
import type { GmailMessage, MessagePart } from './gmailWire';
import { htmlToText } from './htmlText';
import {
  charsetOf,
  decodeBytes,
  decodeEncodedWords,
  hasHiddenCharacters,
  sniffHtmlCharset,
  stripInvisible,
} from './mimeText';

/** Longest header value shown; a header this long is an attack or an accident, never a subject. */
const MAX_HEADER_CHARS = 1000;

/** Longest attachment name and media type kept, cut before anything else looks at them. */
const MAX_FILENAME_CHARS = 255;
const MAX_MIME_CHARS = 100;

/** Longest raw header read at all, so nothing downstream parses an unbounded value. */
export const MAX_RAW_HEADER_CHARS = 10_000;

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** A header as Gmail returned it, cut at the raw limit, with folded lines joined. */
export function rawHeaderOf(input: { part: MessagePart; name: string }): string {
  const wanted = input.name.toLowerCase();
  const value = input.part.headers?.find(header => header.name.toLowerCase() === wanted)?.value ?? '';
  return value.slice(0, MAX_RAW_HEADER_CHARS).replace(/\r?\n[ \t]+/g, ' ');
}

/** True when a header is longer than anything read, so what was read is not all of it. */
export function headerOverflows(part: MessagePart): boolean {
  return (part.headers ?? []).some(header => header.value.length > MAX_RAW_HEADER_CHARS);
}

/** A header's decoded text exactly as written, with nothing removed or cut. */
export function decodedHeaderOf(input: { message: GmailMessage; name: string }): string {
  return input.message.payload === undefined
    ? ''
    : decodeEncodedWords(rawHeaderOf({ part: input.message.payload, name: input.name }));
}

/** A header's value with RFC 2047 encoded words read in their own charset, invisible characters removed, and the length bounded. */
export function headerOf(input: { message: GmailMessage; name: string }): string {
  if (input.message.payload === undefined) {
    return '';
  }
  const value = stripInvisible(decodeEncodedWords(rawHeaderOf({ part: input.message.payload, name: input.name })));
  return value.length > MAX_HEADER_CHARS ? `${value.slice(0, MAX_HEADER_CHARS)}...` : value;
}

function decodePart(input: { part: MessagePart; data: string }): string {
  const bytes = Uint8Array.from(Buffer.from(input.data, 'base64url'));
  const declared = charsetOf(rawHeaderOf({ part: input.part, name: 'content-type' }));
  const charset = declared ?? (input.part.mimeType === 'text/html' ? sniffHtmlCharset(bytes) : null);
  return decodeBytes({ bytes, charset });
}

interface Collected {
  plain: string[];
  html: string[];
  attachments: AttachmentInfo[];
}

function collect(part: MessagePart, into: Collected): void {
  const attachmentId = part.body?.attachmentId;
  if (attachmentId !== undefined) {
    // Any part Gmail serves by attachment id is a file, named or not.
    into.attachments.push({
      id: attachmentId,
      filename:
        part.filename !== undefined && part.filename !== '' ? part.filename.slice(0, MAX_FILENAME_CHARS) : 'attachment',
      mimeType: (part.mimeType ?? 'application/octet-stream').slice(0, MAX_MIME_CHARS),
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
  /** Whether the text had characters that do not show, which were taken out of `body`. */
  hadHiddenText: boolean;
  attachments: AttachmentInfo[];
  /** Whether the message has an HTML alternative, which a send would not carry. */
  hasHtml: boolean;
}

/** The message text (plain text when it has any, otherwise its HTML as text) and its attachments. */
export function readMessage(message: GmailMessage): ReadMessage {
  const found: Collected = { plain: [], html: [], attachments: [] };
  if (message.payload !== undefined) {
    collect(message.payload, found);
  }
  const plain = found.plain.join('\n');
  const body = plain.trim() !== '' ? plain : htmlToText(found.html.join('\n'));
  return {
    body: stripInvisible(body).trim(),
    hadHiddenText: hasHiddenCharacters(body),
    attachments: found.attachments,
    hasHtml: found.html.length > 0,
  };
}

export function labelIdsOf(message: GmailMessage): string[] {
  return message.labelIds ?? [];
}
