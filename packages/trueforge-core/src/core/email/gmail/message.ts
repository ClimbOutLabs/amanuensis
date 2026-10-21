/** Reads a Gmail message into the plain fields the tools return. Mail text is data and is never interpreted here. */
import type { GmailMessage, MessagePart } from './gmailWire';
import { htmlImageLinks, htmlToText, MAX_HTML_CHARS } from './htmlText';
import {
  contentTypeCharset,
  decodeBytes,
  decodeEncodedWords,
  isUsableCharset,
  sniffHtmlCharset,
  stripInvisible,
} from './mimeText';

/** Longest header value shown; a header this long is an attack or an accident, never a subject. */
const MAX_HEADER_CHARS = 1000;

/** Longest attachment name and media type kept, cut before anything else looks at them. */
const MAX_FILENAME_CHARS = 255;
const MAX_MIME_CHARS = 100;
const MAX_HANDLE_CHARS = 64;

/** Longest raw header read at all, so nothing downstream parses an unbounded value. */
export const MAX_RAW_HEADER_CHARS = 10_000;

/**
 * One file of a message. `handle` is the MIME part id, which stays the same across reads; Gmail's `attachmentId`
 * changes on every read, so it is only good for the fetch that follows the read it came from.
 */
export interface AttachmentInfo {
  handle: string;
  /** Absent when Gmail returned the bytes inline in `data`. */
  attachmentId: string | undefined;
  data: string | undefined;
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
export function headerOf(input: { message: GmailMessage; name: string; maxChars?: number | undefined }): string {
  if (input.message.payload === undefined) {
    return '';
  }
  const limit = input.maxChars ?? MAX_HEADER_CHARS;
  const value = stripInvisible(decodeEncodedWords(rawHeaderOf({ part: input.message.payload, name: input.name })));
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

/** Most bytes one character takes in any charset read here; bounds how much of a part a character limit needs. */
const MAX_BYTES_PER_CHAR = 4;

function decodePart(input: { part: MessagePart; data: string; maxChars: number }): {
  text: string;
  usable: boolean;
  cut: boolean;
} {
  // Only the head of a huge part is decoded when the caller reads a bounded prefix.
  const maxBase64 = Number.isFinite(input.maxChars)
    ? Math.ceil((input.maxChars * MAX_BYTES_PER_CHAR) / 3) * 4
    : Number.POSITIVE_INFINITY;
  const partial = input.data.length > maxBase64;
  const bytes = Uint8Array.from(Buffer.from(partial ? input.data.slice(0, maxBase64) : input.data, 'base64url'));
  const declared = contentTypeCharset(rawHeaderOf({ part: input.part, name: 'content-type' }));
  const raw =
    declared.kind === 'ambiguous'
      ? // Readers disagree about which charset applies, so the bytes are shown as they are.
        { text: Buffer.from(bytes).toString('latin1'), usable: false }
      : decodeWith({ bytes, part: input.part, charset: declared.kind === 'one' ? declared.charset : undefined });
  const over = raw.text.length > input.maxChars;
  return { ...raw, text: over ? raw.text.slice(0, input.maxChars) : raw.text, cut: partial || over };
}

function decodeWith(input: { bytes: Uint8Array; part: MessagePart; charset: string | undefined }): {
  text: string;
  usable: boolean;
} {
  const charset = input.charset ?? (input.part.mimeType === 'text/html' ? sniffHtmlCharset(input.bytes) : null);
  return { text: decodeBytes({ bytes: input.bytes, charset }), usable: charset === null || isUsableCharset(charset) };
}

interface Collected {
  /** A text part declared a charset that is UTF-7 or unknown, so what it holds was shown as raw bytes. */
  charsetProblem: boolean;
  plain: string[];
  html: string[];
  /** HTML parts not yet decoded, kept when a bounded read only needs them if there is no plain text. */
  deferredHtml: MessagePart[];
  hasHtml: boolean;
  attachments: AttachmentInfo[];
  attachmentTotal: number;
  plainChars: number;
  htmlChars: number;
  /** Some text was left unread because the character limit was reached. */
  cut: boolean;
}

interface WalkLimits {
  /** Decode text parts at all; false walks the tree for attachments only. */
  text: boolean;
  maxPlainChars: number;
  maxHtmlChars: number;
  maxAttachments: number;
}

const UNLIMITED: WalkLimits = {
  text: true,
  maxPlainChars: Number.POSITIVE_INFINITY,
  maxHtmlChars: Number.POSITIVE_INFINITY,
  maxAttachments: Number.POSITIVE_INFINITY,
};

/** HTML markup is mostly tags, so its text is a fraction of its length; this many times the plain limit is read. */
const HTML_READ_FACTOR = 8;

function newCollected(): Collected {
  return {
    charsetProblem: false,
    plain: [],
    html: [],
    deferredHtml: [],
    hasHtml: false,
    attachments: [],
    attachmentTotal: 0,
    plainChars: 0,
    htmlChars: 0,
    cut: false,
  };
}

function decodeInto(input: { part: MessagePart; data: string; into: Collected; kind: 'plain' | 'html'; max: number }) {
  const { into } = input;
  const used = input.kind === 'plain' ? into.plainChars : into.htmlChars;
  if (used >= input.max) {
    into.cut = true;
    return;
  }
  const decoded = decodePart({ part: input.part, data: input.data, maxChars: input.max - used });
  if (input.kind === 'plain') {
    into.plain.push(decoded.text);
    into.plainChars += decoded.text.length;
  } else {
    into.html.push(decoded.text);
    into.htmlChars += decoded.text.length;
  }
  into.charsetProblem ||= !decoded.usable;
  into.cut ||= decoded.cut;
}

function collect(input: { part: MessagePart; into: Collected; limits: WalkLimits }): void {
  const { part, into, limits } = input;
  const attachmentId = part.body?.attachmentId;
  const named = part.filename !== undefined && part.filename !== '';
  // Gmail serves small files inline in body.data; a named part with data is a file, not message text.
  const inlineData = attachmentId === undefined && named ? part.body?.data : undefined;
  if (attachmentId !== undefined || inlineData !== undefined) {
    // Any part Gmail serves by attachment id is a file, named or not.
    into.attachmentTotal += 1;
    // Gmail sends an empty part id when the whole message is the file; an empty handle can never be opened.
    const partId = part.partId === undefined || part.partId === '' ? undefined : part.partId;
    if (into.attachments.length < limits.maxAttachments) {
      into.attachments.push({
        handle: (partId ?? `att${String(into.attachmentTotal)}`).slice(0, MAX_HANDLE_CHARS),
        attachmentId,
        data: inlineData,
        filename: named ? (part.filename ?? '').slice(0, MAX_FILENAME_CHARS) : 'attachment',
        mimeType: (part.mimeType ?? 'application/octet-stream').slice(0, MAX_MIME_CHARS),
        size: part.body?.size ?? Math.floor(((inlineData ?? '').length * 3) / 4),
      });
    }
  } else if (part.body?.data !== undefined && (part.filename === undefined || part.filename === '')) {
    if (part.mimeType === 'text/plain' && limits.text) {
      decodeInto({ part, data: part.body.data, into, kind: 'plain', max: limits.maxPlainChars });
    } else if (part.mimeType === 'text/html') {
      into.hasHtml = true;
      if (limits.text) {
        if (Number.isFinite(limits.maxPlainChars)) {
          into.deferredHtml.push(part);
        } else {
          decodeInto({ part, data: part.body.data, into, kind: 'html', max: limits.maxHtmlChars });
        }
      }
    }
  }
  for (const child of part.parts ?? []) {
    collect({ part: child, into, limits });
  }
}

function walk(input: { message: GmailMessage; limits: WalkLimits }): Collected {
  const found = newCollected();
  if (input.message.payload !== undefined) {
    collect({ part: input.message.payload, into: found, limits: input.limits });
  }
  const plainBlank = found.plain.join('').trim() === '';
  if (input.limits.text && plainBlank) {
    for (const part of found.deferredHtml) {
      decodeInto({ part, data: part.body?.data ?? '', into: found, kind: 'html', max: input.limits.maxHtmlChars });
    }
  }
  return found;
}

interface ReadMessage {
  /** The message text for reading: hidden characters removed, surrounding whitespace trimmed. */
  body: string;
  /** The plain-text part exactly as written, with nothing removed or trimmed: what a send delivers. */
  plainText: string;
  /** A text part declared a charset that is UTF-7 or unknown. */
  charsetProblem: boolean;
  attachments: AttachmentInfo[];
  /** Whether the message has an HTML alternative, which a send would not carry. */
  hasHtml: boolean;
}

/** The message text (plain text when it has any, otherwise its HTML as text) and its attachments, all of it. */
export function readMessage(message: GmailMessage): ReadMessage {
  const found = walk({ message, limits: UNLIMITED });
  const plain = found.plain.join('\n');
  const body = plain.trim() !== '' ? plain : htmlToText(found.html.join('\n'));
  return {
    body: stripInvisible(body).trim(),
    plainText: plain,
    charsetProblem: found.charsetProblem,
    attachments: found.attachments,
    hasHtml: found.hasHtml,
  };
}

/**
 * The start of a message's text for a result: plain text when it has any, otherwise its HTML as text. Text
 * past `maxChars` is never decoded, and `cut` says some was left unread.
 */
export function readBody(input: { message: GmailMessage; maxChars: number }): { body: string; cut: boolean } {
  const found = walk({
    message: input.message,
    limits: {
      text: true,
      maxPlainChars: input.maxChars,
      maxHtmlChars: input.maxChars * HTML_READ_FACTOR,
      maxAttachments: 0,
    },
  });
  const plain = found.plain.join('\n');
  const body = plain.trim() !== '' ? plain : htmlToText(found.html.join('\n'));
  return { body: stripInvisible(body).trim(), cut: found.cut };
}

/** The web addresses of a message's HTML images, at most `max`; the HTML is read up to its usual limit. */
export function linkedImagesOf(input: { message: GmailMessage; max: number }): string[] {
  const found = walk({
    message: input.message,
    limits: { text: true, maxPlainChars: Number.POSITIVE_INFINITY, maxHtmlChars: MAX_HTML_CHARS, maxAttachments: 0 },
  });
  return htmlImageLinks({ source: found.html.join('\n'), max: input.max });
}

/** The first `max` attachments of a message and how many it has, found without decoding any text. */
export function listAttachments(input: { message: GmailMessage; max: number }): {
  attachments: AttachmentInfo[];
  total: number;
} {
  const found = walk({
    message: input.message,
    limits: { text: false, maxPlainChars: 0, maxHtmlChars: 0, maxAttachments: input.max },
  });
  return { attachments: found.attachments, total: found.attachmentTotal };
}

export function labelIdsOf(message: GmailMessage): string[] {
  return message.labelIds ?? [];
}
