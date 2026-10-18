// download_email + download_attachment ops.
//
// Write destination sandboxing: both tools accept a caller-supplied `savePath`
// that resolves inside the downloads sandbox (`<configDir>/downloads`, or
// GMAIL_DOWNLOADS_DIR). Relative paths resolve inside it; absolute paths must
// land inside it; symlinked components that escape it are rejected after
// realpath resolution. Filenames are additionally reduced to their basename
// via safeJoinWithinBase, so Gmail-supplied attachment filenames cannot
// traverse out of the resolved directory either.
// download_email format branches: json/eml/txt/html.

import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { emailToHtml, emailToTxt, gmailMessageToJson } from "../../email-export.js";
import { resolveSandboxedDir, safeJoinWithinBase, writeFileNoFollow } from "../../safe-path.js";
import {
  DownloadAttachmentOutputSchema,
  DownloadAttachmentSchema,
  DownloadEmailOutputSchema,
  DownloadEmailSchema,
} from "../../tools.js";
import {
  extractAttachments,
  extractEmailContent,
  extractHeaders,
  type GmailMessagePart,
} from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";
import { getDownloadsDir } from "../config-paths.js";
import { apiOpts } from "../api.js";

type DownloadEmailOutput = z.infer<typeof DownloadEmailOutputSchema>;

/** Largest attachment also returned inline as an image block for the host to show. */
const INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The image MIME type of a picture attachment, from its leading bytes, or null. Only these four types
 * are returned inline; the host re-encodes them in its sandbox before anything is shown.
 */
function inlineImageMime(buffer: Buffer): string | null {
  if (buffer.length > INLINE_IMAGE_MAX_BYTES) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const head = buffer.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}
type DownloadAttachmentOutput = z.infer<typeof DownloadAttachmentOutputSchema>;

const downloadEmail: Operation<unknown, DownloadEmailOutput> = {
  name: "download_email",
  schema: DownloadEmailSchema,
  outputSchema: DownloadEmailOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { messageId: string; savePath?: string; format: string };
    const { messageId, savePath, format } = args;

    try {
      const sandbox = getDownloadsDir();
      const resolvedDir = resolveSandboxedDir(sandbox, savePath);

      const fullResponse = await ctx.gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      }, apiOpts(ctx));

      const { subject, from, date } = extractHeaders(fullResponse.data.payload);
      const attachments = extractAttachments(fullResponse.data.payload as GmailMessagePart);

      let content: string;

      if (format === "eml") {
        const rawResponse = await ctx.gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "raw",
        }, apiOpts(ctx));
        content = Buffer.from(rawResponse.data.raw || "", "base64url").toString("utf-8");
      } else {
        const emailContent = extractEmailContent(
          (fullResponse.data.payload as GmailMessagePart) || {},
        );

        if (format === "json") {
          const jsonData = gmailMessageToJson(fullResponse.data, emailContent, attachments);
          content = JSON.stringify(jsonData, null, 2);
        } else if (format === "txt") {
          content = emailToTxt(fullResponse.data, emailContent, attachments);
        } else {
          // html
          content = emailToHtml(emailContent);
        }
      }

      const fullPath = safeJoinWithinBase(resolvedDir, `${messageId}.${format}`);
      // No-follow write: a pre-planted symlink at the destination must not
      // redirect the email content outside the sandbox.
      writeFileNoFollow(fullPath, content);
      const stats = fs.statSync(fullPath);

      const result = {
        status: "saved" as const,
        path: fullPath,
        size: stats.size,
        messageId,
        subject,
        from,
        date,
        format: format as "json" | "eml" | "txt" | "html",
        attachments,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Failed to download email: ${error.message}` }],
        isError: true,
      };
    }
  },
};

const downloadAttachment: Operation<unknown, DownloadAttachmentOutput> = {
  name: "download_attachment",
  schema: DownloadAttachmentSchema,
  outputSchema: DownloadAttachmentOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as {
      messageId: string;
      attachmentId: string;
      savePath?: string;
      filename?: string;
    };

    try {
      // Resolve the sandbox before any network I/O: a traversal savePath
      // must fail without issuing Gmail API calls.
      const sandbox = getDownloadsDir();
      const resolvedDir = resolveSandboxedDir(sandbox, args.savePath);

      const attachmentResponse = await ctx.gmail.users.messages.attachments.get({
        userId: "me",
        messageId: args.messageId,
        id: args.attachmentId,
      }, apiOpts(ctx));

      if (!attachmentResponse.data.data) {
        throw new Error("No attachment data received");
      }

      const data = attachmentResponse.data.data;
      const buffer = Buffer.from(data, "base64url");

      let filename = args.filename;

      if (!filename) {
        const messageResponse = await ctx.gmail.users.messages.get({
          userId: "me",
          id: args.messageId,
          format: "full",
        }, apiOpts(ctx));

        const findAttachment = (part: any): string | null => {
          if (part.body && part.body.attachmentId === args.attachmentId) {
            return part.filename || `attachment-${args.attachmentId}`;
          }
          if (part.parts) {
            for (const subpart of part.parts) {
              const found = findAttachment(subpart);
              if (found) return found;
            }
          }
          return null;
        };

        filename =
          findAttachment(messageResponse.data.payload) || `attachment-${args.attachmentId}`;
      }

      const fullPath = safeJoinWithinBase(resolvedDir, filename);
      // Update the user-facing filename to the sanitized basename.
      filename = path.basename(filename);
      // No-follow write: a pre-planted symlink at the destination must not
      // redirect the attachment bytes outside the sandbox.
      writeFileNoFollow(fullPath, buffer);

      const imageMime = inlineImageMime(buffer);
      return {
        content: [
          {
            type: "text",
            text: `Attachment downloaded successfully:\nFile: ${filename}\nSize: ${buffer.length} bytes\nSaved to: ${fullPath}`,
          },
          ...(imageMime === null ? [] : [{ type: "image" as const, data: buffer.toString("base64"), mimeType: imageMime }]),
        ],
        structuredContent: {
          status: "saved",
          path: fullPath,
          filename,
          size: buffer.length,
          messageId: args.messageId,
          attachmentId: args.attachmentId,
        },
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Failed to download attachment: ${error.message}` }],
        isError: true,
      };
    }
  },
};

registry.register(downloadEmail);
registry.register(downloadAttachment);
