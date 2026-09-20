import fs from "fs";
import { lookup as mimeLookup } from "mime-types";
import nodemailer from "nodemailer";
import path from "path";
import { getAttachmentsDir } from "./core/config-paths.js";
import { resolveSandboxedFile } from "./safe-path.js";

export const MAX_INLINE_IMAGE_CONTENT_BYTES = 10 * 1024 * 1024;
const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
]);

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
  // Only encode if the text contains non-ASCII characters
  // eslint-disable-next-line no-control-regex -- \x00 is intentional: expresses the ASCII range for RFC 2047 encoding
  if (/[^\x00-\x7F]/.test(text)) {
    // Use MIME Words encoding (RFC 2047)
    return `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;
  }
  return text;
}

export const validateEmail = (email: string): boolean => {
  // Accept the RFC-5322 display-name form ("Name <a@b.com>") by validating the
  // bracketed address; the caller keeps the full string verbatim, which
  // nodemailer/Gmail accept, so the display name survives in the sent header.
  // A bare address is validated as-is, preserving the strict old behaviour
  // (e.g. rejecting stray surrounding whitespace).
  const angle = email.match(/<([^>]+)>/);
  const addr = angle ? angle[1].trim() : email;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(addr);
};

/**
 * Sanitize a value destined for an email header to prevent CRLF injection.
 * Strips \r, \n, and \0 characters that could inject additional headers.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]/g, "");
}

export function createEmailMessage(validatedArgs: any): string {
  const encodedSubject = encodeEmailHeader(sanitizeHeaderValue(validatedArgs.subject));
  // Determine content type based on available content and explicit mimeType
  let mimeType = validatedArgs.mimeType || "text/plain";

  // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
  // use multipart/alternative to include both versions
  if (validatedArgs.htmlBody && mimeType !== "text/plain") {
    mimeType = "multipart/alternative";
  }

  // Generate a random boundary string for multipart messages
  const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;

  // Validate email addresses
  (validatedArgs.to as string[]).forEach((email) => {
    if (!validateEmail(email)) {
      throw new Error(`Recipient email address is invalid: ${email}`);
    }
  });

  // Sanitize all user-supplied header values to prevent CRLF injection
  const from = sanitizeHeaderValue(validatedArgs.from || "me");
  const to = (validatedArgs.to as string[]).map(sanitizeHeaderValue).join(", ");
  const cc = validatedArgs.cc
    ? (validatedArgs.cc as string[]).map(sanitizeHeaderValue).join(", ")
    : "";
  const bcc = validatedArgs.bcc
    ? (validatedArgs.bcc as string[]).map(sanitizeHeaderValue).join(", ")
    : "";
  const inReplyTo = validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : "";
  const messageId = validatedArgs.rfc822MessageId
    ? sanitizeHeaderValue(String(validatedArgs.rfc822MessageId))
    : "";
  const references = validatedArgs.references
    ? sanitizeHeaderValue(validatedArgs.references)
    : validatedArgs.inReplyTo
      ? sanitizeHeaderValue(validatedArgs.inReplyTo)
      : "";

  // Common email headers
  const emailParts = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    bcc ? `Bcc: ${bcc}` : "",
    `Subject: ${encodedSubject}`,
    messageId ? `Message-ID: ${messageId}` : "",
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    references ? `References: ${references}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);

  // Construct the email based on the content type
  if (mimeType === "multipart/alternative") {
    // Multipart email with both plain text and HTML
    emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    emailParts.push("");

    // Plain text part
    emailParts.push(`--${boundary}`);
    emailParts.push("Content-Type: text/plain; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(validatedArgs.body);
    emailParts.push("");

    // HTML part
    emailParts.push(`--${boundary}`);
    emailParts.push("Content-Type: text/html; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
    emailParts.push("");

    // Close the boundary
    emailParts.push(`--${boundary}--`);
  } else if (mimeType === "text/html") {
    // HTML-only email
    emailParts.push("Content-Type: text/html; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(validatedArgs.htmlBody || validatedArgs.body);
  } else {
    // Plain text email (default)
    emailParts.push("Content-Type: text/plain; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(validatedArgs.body);
  }

  return emailParts.join("\r\n");
}

export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
  // Validate email addresses
  (validatedArgs.to as string[]).forEach((email) => {
    if (!validateEmail(email)) {
      throw new Error(`Recipient email address is invalid: ${email}`);
    }
  });

  // Create a nodemailer transporter (we won't actually send, just generate the message)
  const transporter = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: true,
  });

  const inlineImages = validatedArgs.inlineImages ?? [];
  if (inlineImages.length > 0 && !validatedArgs.htmlBody) {
    throw new Error("inlineImages require htmlBody");
  }

  // Prepare attachments for nodemailer. Caller-supplied paths are confined
  // to the attachments sandbox (<configDir>/attachments, or
  // GMAIL_ATTACHMENTS_DIR): relative paths resolve inside it, absolute
  // paths must land inside it, and symlinks escaping it are rejected.
  const attachmentsDir = getAttachmentsDir();
  const attachments: Array<Record<string, unknown>> = [];
  for (const filePath of validatedArgs.attachments ?? []) {
    const resolved = resolveSandboxedFile(attachmentsDir, String(filePath));

    const fileName = path.basename(resolved);

    attachments.push({
      filename: fileName,
      path: resolved,
    });
  }

  for (const image of inlineImages) {
    const cid = sanitizeHeaderValue(String(image.cid ?? ""));
    if (!cid || /[\s<>]/.test(cid)) {
      throw new Error("Inline image cid contains invalid characters");
    }

    const attachment: Record<string, unknown> = {
      cid,
      filename: image.filename ? path.basename(image.filename) : cid,
      contentDisposition: "inline",
    };

    if (image.path) {
      const resolvedImage = resolveSandboxedFile(attachmentsDir, String(image.path));
      const size = fs.statSync(resolvedImage).size;
      if (size > MAX_INLINE_IMAGE_CONTENT_BYTES) {
        throw new Error(`Inline image '${cid}' exceeds the 10 MB size limit`);
      }
      const inferredType = image.contentType || mimeLookup(resolvedImage);
      if (typeof inferredType !== "string" || !INLINE_IMAGE_MIME_TYPES.has(inferredType)) {
        throw new Error(`Inline image '${cid}' must use a supported raster image MIME type`);
      }
      attachment.path = resolvedImage;
      attachment.filename = image.filename
        ? path.basename(image.filename)
        : path.basename(resolvedImage);
      attachment.contentType = inferredType;
    } else {
      const content = String(image.content ?? "");
      const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
      const decodedSize = Math.floor((content.length * 3) / 4) - padding;
      if (decodedSize > MAX_INLINE_IMAGE_CONTENT_BYTES) {
        throw new Error(`Inline image '${cid}' exceeds the 10 MB size limit`);
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
        throw new Error(`Inline image '${cid}' content must be valid base64`);
      }
      const decoded = Buffer.from(content, "base64");
      if (!INLINE_IMAGE_MIME_TYPES.has(image.contentType)) {
        throw new Error(`Inline image '${cid}' must use a supported raster image MIME type`);
      }
      attachment.content = decoded;
      attachment.contentType = image.contentType;
    }

    attachments.push(attachment);
  }

  const mailOptions = {
    from: validatedArgs.from || "me", // Gmail API uses default send-as if 'me', or specified alias
    to: validatedArgs.to.join(", "),
    cc: validatedArgs.cc?.join(", "),
    bcc: validatedArgs.bcc?.join(", "),
    subject: validatedArgs.subject,
    text: validatedArgs.body,
    html: validatedArgs.htmlBody,
    attachments: attachments,
    inReplyTo: validatedArgs.inReplyTo,
    references: validatedArgs.references || validatedArgs.inReplyTo,
    // Our own Message-ID for idempotency crash-recovery (searchable via
    // rfc822msgid:). When absent, nodemailer generates one as before.
    messageId: validatedArgs.rfc822MessageId || undefined,
  };

  // Generate the raw message. Nodemailer hands back a Buffer with
  // streamTransport, a message-id string with real transports.
  const info = await transporter.sendMail(mailOptions);
  const sentMessage: unknown = info.message;
  let rawMessage: string;
  if (typeof sentMessage === "string") rawMessage = sentMessage;
  else if (Buffer.isBuffer(sentMessage)) rawMessage = sentMessage.toString("utf8");
  else rawMessage = JSON.stringify(sentMessage) ?? "";

  return rawMessage;
}

/** Messages containing attachments or CID images require the MIME builder. */
export function needsRawBuilder(args: unknown): boolean {
  const value = args as { attachments?: unknown[]; inlineImages?: unknown[] } | undefined;
  return Boolean(value?.attachments?.length || value?.inlineImages?.length);
}
