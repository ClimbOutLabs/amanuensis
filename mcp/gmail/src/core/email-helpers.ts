// Pure helpers for parsing Gmail message payloads.
// Surface-agnostic — used by message reads, threads, downloads.
//
// Lifted from src/index.ts as part of the modular refactor. No behavior change.

import type { EmailAttachment } from "../email-export.js";

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{
    name: string;
    value: string;
  }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

export interface EmailContent {
  text: string;
  html: string;
}

/** Completeness metadata attached to every list-shaped tool output so callers
    never have to guess whether a result set was silently capped. */
export interface ListMeta {
  /** True if the server has more results than were returned in this response
      (a nextPageToken exists, or the estimate exceeds the returned count). */
  truncated: boolean;
  /** Best-effort total number of matching items. Equals the returned count for
      fully-enumerated lists (labels, filters, accounts); for paginated queries
      it is Gmail's server-side estimate across all pages. */
  total_available: number;
}

/**
 * Derive {@link ListMeta} for a list response. `count` is what this response
 * returns; `estimate` is a server-side total estimate when available (e.g.
 * Gmail's resultSizeEstimate); `nextPageToken` marks that more pages exist.
 */
export function listMeta(
  count: number,
  opts: { estimate?: number | null; nextPageToken?: string | null } = {},
): ListMeta {
  const hasMore = Boolean(opts.nextPageToken);
  const estimate = typeof opts.estimate === "number" ? opts.estimate : count;
  const total_available = Math.max(estimate, count);
  return { truncated: hasMore || total_available > count, total_available };
}

export interface ExtractedHeaders {
  subject: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  date: string;
  rfcMessageId: string;
}

/**
 * Recursively extract email body content from MIME message parts. Handles
 * complex email structures with nested multipart payloads.
 */
export function extractEmailContent(messagePart: GmailMessagePart): EmailContent {
  let textContent = "";
  let htmlContent = "";

  if (messagePart.body?.data) {
    const content = Buffer.from(messagePart.body.data, "base64").toString("utf8");
    if (messagePart.mimeType === "text/plain") {
      textContent = content;
    } else if (messagePart.mimeType === "text/html") {
      htmlContent = content;
    }
  }

  if (messagePart.parts && messagePart.parts.length > 0) {
    for (const part of messagePart.parts) {
      const { text, html } = extractEmailContent(part);
      if (text) textContent += text;
      if (html) htmlContent += html;
    }
  }

  return { text: textContent, html: htmlContent };
}

/**
 * Convert a small HTML email body into readable terminal text. This is not a
 * full DOM renderer; it is deliberately conservative and dependency-free for
 * Gmail bodies where we only need plain text fallback.
 */
export function htmlToText(html: string): string {
  if (!html) return "";
  const withoutUnsafeBlocks = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(
      /<\s*\/\s*(p|div|h[1-6]|blockquote|tr|table|section|article)\s*>\s*<\s*br\s*\/?\s*>/gi,
      "\n",
    )
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|blockquote|tr|table|section|article)\s*>/gi, "\n\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<\s*\/\s*li\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(withoutUnsafeBlocks)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function readableEmailBody(content: EmailContent): string {
  return content.text || htmlToText(content.html) || "";
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[lower] ?? match;
  });
}

/**
 * Extract common headers from a Gmail message payload (subject / from / to /
 * date / message-id). Case-insensitive header lookup; returns empty strings
 * for missing values rather than undefined so callers can compose unchecked.
 */
export function extractHeaders(
  // Accept any payload that exposes a `headers` array of {name, value}
  // entries. Loosely typed because Gmail's generated types allow `null` on
  // both `name` and `value` (and some callers pass headers from MIME parsers
  // with different shapes); we coerce both to strings at lookup time.
  payload: { headers?: Array<{ name?: string | null; value?: string | null }> } | undefined | null,
): ExtractedHeaders {
  const headers = payload?.headers ?? [];
  const getHeader = (name: string): string => {
    const found = headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
    return found?.value ?? "";
  };
  return {
    subject: getHeader("subject"),
    from: getHeader("from"),
    to: getHeader("to"),
    cc: getHeader("cc"),
    bcc: getHeader("bcc"),
    date: getHeader("date"),
    rfcMessageId: getHeader("message-id"),
  };
}

/**
 * Walk a Gmail message payload tree and collect every attachment encountered
 * (anything with a `body.attachmentId`). Used by read_email, download_email,
 * download_attachment.
 */
export function extractAttachments(payload: GmailMessagePart): EmailAttachment[] {
  const attachments: EmailAttachment[] = [];

  function processAttachmentParts(part: GmailMessagePart) {
    if (part.body?.attachmentId) {
      attachments.push({
        id: part.body.attachmentId,
        filename: part.filename || `attachment-${part.body.attachmentId}`,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      part.parts.forEach((subpart: GmailMessagePart) => {
        processAttachmentParts(subpart);
      });
    }
  }

  processAttachmentParts(payload);
  return attachments;
}
