/** Reads a Gmail message into the plain fields the tools return. Mail text is data and is never interpreted here. */
import type { GmailMessage, MessagePart } from './gmailWire';
import { htmlToText } from './htmlText';
import { charsetOf, decodeBytes, decodeEncodedWords, sniffHtmlCharset, stripInvisible } from './mimeText';

/** Longest header value kept; a header this long is an attack or an accident, never a subject. */
const MAX_HEADER_CHARS = 1000;

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** A header exactly as Gmail returned it, with folded lines joined. */
export function rawHeaderOf(input: { part: MessagePart; name: string }): string {
  const wanted = input.name.toLowerCase();
  const value = input.part.headers?.find(header => header.name.toLowerCase() === wanted)?.value ?? '';
  return value.replace(/\r?\n[ \t]+/g, ' ');
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
      filename: part.filename !== undefined && part.filename !== '' ? part.filename : 'attachment',
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
  return { body: stripInvisible(body).trim(), attachments: found.attachments, hasHtml: found.html.length > 0 };
}

export function labelIdsOf(message: GmailMessage): string[] {
  return message.labelIds ?? [];
}
