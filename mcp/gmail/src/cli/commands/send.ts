// `gmail-cli send / reply-all / draft` — outgoing-mail commands.
//
// Body input precedence: --body = literal | --body @file (file read) |
// --body - (stdin). Plus --cc, --bcc, --attach (repeatable), --thread-id,
// --in-reply-to, --html.

import { Command } from "commander";
import { exitCli, resolveBodyInput, runCliOp } from "../runtime.js";

interface SendOptions {
  to?: string;
  subject?: string;
  body?: string;
  html?: string;
  cc?: string;
  bcc?: string;
  attach?: string[];
  inlineImage?: string[];
  threadId?: string;
  inReplyTo?: string;
  from?: string;
  mimeType?: "text/plain" | "text/html" | "multipart/alternative";
  json?: boolean;
}

function parseInlineImages(values: string[] | undefined): unknown[] | undefined {
  if (!values?.length) return undefined;
  return values.map((value) => {
    if (value.trim().startsWith("{")) return JSON.parse(value);
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error('Usage error: --inline-image expects "cid=/path/to/image" or a JSON object');
    }
    return { cid: value.slice(0, separator), path: value.slice(separator + 1) };
  });
}

async function resolveSendArgs(options: SendOptions) {
  if (!options.to || !options.subject) {
    throw new Error("Usage error: --to and --subject are required");
  }
  const body = await resolveBodyInput(options.body);
  if (body === undefined) {
    throw new Error(
      "Usage error: --body is required (use '-' for stdin, '@file' to read from disk)",
    );
  }
  return {
    to: options.to.split(",").map((s) => s.trim()),
    subject: options.subject,
    body,
    htmlBody: options.html,
    cc: options.cc?.split(",").map((s) => s.trim()),
    bcc: options.bcc?.split(",").map((s) => s.trim()),
    attachments: options.attach,
    inlineImages: parseInlineImages(options.inlineImage),
    threadId: options.threadId,
    inReplyTo: options.inReplyTo,
    from: options.from,
    mimeType: options.mimeType ?? "text/plain",
  };
}

function attachSendOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-t, --to <addresses>", "Comma-separated recipients")
    .requiredOption("-s, --subject <text>", "Subject line")
    .option(
      "-b, --body <text>",
      "Body. Literal text, '-' for stdin, or '@path/to/file' to read from disk.",
    )
    .option("--html <text>", "HTML body (separate from --body / used for multipart)")
    .option("--cc <addresses>", "Comma-separated CC")
    .option("--bcc <addresses>", "Comma-separated BCC")
    .option(
      "--attach <path>",
      "Attach a file (repeatable)",
      (val, prev: string[] = []) => prev.concat(val),
      [] as string[],
    )
    .option(
      "--inline-image <cid=path|json>",
      "Embed a CID image (repeatable); JSON form also supports base64 content",
      (val, prev: string[] = []) => prev.concat(val),
      [] as string[],
    )
    .option("--thread-id <id>", "Reply within this thread")
    .option("--in-reply-to <messageId>", "RFC822 Message-ID being replied to")
    .option("--from <address>", "Send-as alias (must be configured in Gmail)")
    .option(
      "--mime-type <type>",
      "text/plain | text/html | multipart/alternative (default: text/plain)",
    )
    .option("--json", "Emit typed JSON instead of human text");
}

export function buildSendCommand(): Command {
  return attachSendOptions(new Command("send"))
    .description("Send an email")
    .action(async (options: SendOptions) => {
      const args = await resolveSendArgs(options);
      await runCliOp("send_email", args, { json: options.json });
    });
}

export function buildDraftCommand(): Command {
  return attachSendOptions(new Command("draft"))
    .description("Create a draft email (does not send)")
    .action(async (options: SendOptions) => {
      const args = await resolveSendArgs(options);
      await runCliOp("draft_email", args, { json: options.json });
    });
}

export function buildSendDraftCommand(): Command {
  return new Command("send-draft")
    .description("Send an existing Gmail draft and remove it from Drafts")
    .argument("<draftId>", "Gmail draft ID")
    .option("--json", "Emit typed JSON")
    .action(async (draftId: string, options: { json?: boolean }) => {
      await runCliOp("send_draft", { draftId }, { json: options.json });
    });
}

export function buildUpdateDraftCommand(): Command {
  return attachSendOptions(new Command("update-draft"))
    .description("Replace an existing Gmail draft's content")
    .argument("<draftId>", "Gmail draft ID")
    .action(async (draftId: string, options: SendOptions) => {
      const args = await resolveSendArgs(options);
      await runCliOp("update_draft", { draftId, ...args }, { json: options.json });
    });
}

export function buildDeleteDraftCommand(): Command {
  return new Command("delete-draft")
    .description("Delete an existing Gmail draft")
    .argument("<draftId>", "Gmail draft ID")
    .option("--json", "Emit typed JSON")
    .action(async (draftId: string, options: { json?: boolean }) => {
      await runCliOp("delete_draft", { draftId }, { json: options.json });
    });
}

export function buildReplyAllCommand(): Command {
  const cmd = new Command("reply-all");
  cmd
    .description("Reply-all to an existing message (auto-builds To/CC and threading headers)")
    .argument("<messageId>", "Gmail message ID to reply-all to")
    .option(
      "-b, --body <text>",
      "Body. Literal text, '-' for stdin, or '@path/to/file' to read from disk.",
    )
    .option("--html <text>", "HTML body")
    .option(
      "--attach <path>",
      "Attach a file (repeatable)",
      (val, prev: string[] = []) => prev.concat(val),
      [] as string[],
    )
    .option(
      "--inline-image <cid=path|json>",
      "Embed a CID image (repeatable); JSON form also supports base64 content",
      (val, prev: string[] = []) => prev.concat(val),
      [] as string[],
    )
    .option(
      "--mime-type <type>",
      "text/plain | text/html | multipart/alternative (default: text/plain)",
    )
    .option("--json", "Emit typed JSON")
    .action(
      async (
        messageId: string,
        options: {
          body?: string;
          html?: string;
          attach?: string[];
          inlineImage?: string[];
          mimeType?: "text/plain" | "text/html" | "multipart/alternative";
          json?: boolean;
        },
      ) => {
        const body = await resolveBodyInput(options.body);
        if (body === undefined) {
          process.stderr.write(
            "Error: --body is required (use '-' for stdin, '@file' to read from disk)\n",
          );
          exitCli(3);
        }
        await runCliOp(
          "reply_all",
          {
            messageId,
            body,
            htmlBody: options.html,
            attachments: options.attach,
            inlineImages: parseInlineImages(options.inlineImage),
            mimeType: options.mimeType ?? "text/plain",
          },
          { json: options.json },
        );
      },
    );
  return cmd;
}
