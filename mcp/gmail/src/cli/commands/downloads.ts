// `gmail-cli download-email / download-attachment` — pull messages and
// attachments to disk. Path-traversal protected via safeJoinWithinBase
// inside the op handler.

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function buildDownloadEmailCommand(): Command {
  const cmd = new Command("download-email");
  cmd
    .description("Download an email to disk (json / eml / txt / html)")
    .argument("<messageId>", "Gmail message ID")
    .requiredOption("-o, --save-path <dir>", "Directory to save the file in")
    .option(
      "-f, --format <fmt>",
      "json | eml | txt | html (default: json)",
      (v: string) => {
        if (!["json", "eml", "txt", "html"].includes(v)) {
          throw new Error(`Invalid format: ${v}. Must be one of: json, eml, txt, html`);
        }
        return v;
      },
      "json",
    )
    .option("--json", "Emit typed JSON")
    .action(
      async (messageId: string, options: { savePath: string; format: string; json?: boolean }) => {
        await runCliOp(
          "download_email",
          { messageId, savePath: options.savePath, format: options.format },
          { json: options.json },
        );
      },
    );
  return cmd;
}

export function buildDownloadAttachmentCommand(): Command {
  const cmd = new Command("download-attachment");
  cmd
    .description("Download an attachment to disk")
    .argument("<messageId>", "Gmail message ID")
    .argument("<attachmentId>", "Attachment ID (from read_email output)")
    .option("-o, --save-path <dir>", "Directory to save into (default: cwd)")
    .option("--filename <name>", "Override the saved filename")
    .option("--json", "Emit typed JSON")
    .action(
      async (
        messageId: string,
        attachmentId: string,
        options: { savePath?: string; filename?: string; json?: boolean },
      ) => {
        await runCliOp(
          "download_attachment",
          {
            messageId,
            attachmentId,
            savePath: options.savePath,
            filename: options.filename,
          },
          { json: options.json },
        );
      },
    );
  return cmd;
}
