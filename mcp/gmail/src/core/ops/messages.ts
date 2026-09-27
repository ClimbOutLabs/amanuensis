// Message-level ops: read, search, modify (labels), delete.
//
// Lifted verbatim from the dispatcher switch in src/index.ts during the
// modular refactor (Step 4). Zero behavior change — same Gmail calls, same
// output text, same retry/rate-limit wrapping for the read paths.

import { rateLimitAcquire, withRetry } from "@george43g/robustness";
import type { z } from "zod";
import { type ParsedAddress, parseEmailAddress, parseEmailAddresses } from "../../email-export.js";
import {
  DeleteEmailSchema,
  ModifyEmailSchema,
  ModifyOrDeleteEmailOutputSchema,
  ReadEmailOutputSchema,
  ReadEmailSchema,
  ReportPhishingOutputSchema,
  ReportPhishingSchema,
  SearchEmailsOutputSchema,
  SearchEmailsSchema,
} from "../../tools.js";
import {
  extractAttachments,
  extractEmailContent,
  extractHeaders,
  type GmailMessagePart,
  listMeta,
  readableEmailBody,
} from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";
import { apiOpts } from "../api.js";
import { fanoutMap } from "../fanout.js";

/** Lowercase the email of a parsed address (names are left untouched) so
    downstream consumers can correlate addresses case-insensitively. */
const lowerEmail = (a: ParsedAddress): ParsedAddress => ({
  name: a.name,
  email: a.email.toLowerCase(),
});

type ReadEmailOutput = z.infer<typeof ReadEmailOutputSchema>;
type SearchEmailsOutput = z.infer<typeof SearchEmailsOutputSchema>;
type ModifyOrDeleteEmailOutput = z.infer<typeof ModifyOrDeleteEmailOutputSchema>;
type ReportPhishingOutput = z.infer<typeof ReportPhishingOutputSchema>;

const readEmail: Operation<unknown, ReadEmailOutput> = {
  name: "read_email",
  schema: ReadEmailSchema,
  outputSchema: ReadEmailOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { messageId: string };
    await rateLimitAcquire();
    const response = await withRetry(
      () =>
        ctx.gmail.users.messages.get({
          userId: "me",
          id: args.messageId,
          format: "full",
        }, apiOpts(ctx)),
      { label: "gmail_messages_get" },
    );

    const { subject, from, to, cc, bcc, date, rfcMessageId } = extractHeaders(
      response.data.payload,
    );
    const threadId = response.data.threadId || "";
    const extracted = extractEmailContent((response.data.payload as GmailMessagePart) || {});
    const { text, html } = extracted;
    const attachments = extractAttachments(response.data.payload as GmailMessagePart);

    const body = readableEmailBody(extracted);
    const attachmentInfo =
      attachments.length > 0
        ? `\n\nAttachments (${attachments.length}):\n` +
          attachments
            .map(
              (a) =>
                `- ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)} KB, ID: ${a.id})`,
            )
            .join("\n")
        : "";

    return {
      content: [
        {
          type: "text",
          text: `Thread ID: ${threadId}\nMessage-ID: ${rfcMessageId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}${cc ? `\nCC: ${cc}` : ""}${bcc ? `\nBCC: ${bcc}` : ""}\nDate: ${date}\n\n${body}${attachmentInfo}`,
        },
      ],
      structuredContent: {
        messageId: args.messageId,
        threadId,
        subject,
        from,
        to,
        cc,
        bcc,
        date,
        rfcMessageId,
        body,
        bodyText: text,
        bodyHtml: html,
        attachments,
      },
    };
  },
};

const searchEmails: Operation<unknown, SearchEmailsOutput> = {
  name: "search_emails",
  schema: SearchEmailsSchema,
  outputSchema: SearchEmailsOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { query: string; maxResults?: number; pageToken?: string };
    await rateLimitAcquire();
    const response = await withRetry(
      () =>
        ctx.gmail.users.messages.list({
          userId: "me",
          q: args.query,
          maxResults: args.maxResults || 10,
          ...(args.pageToken ? { pageToken: args.pageToken } : {}),
        }, apiOpts(ctx)),
      { label: "gmail_messages_list" },
    );

    const messages = response.data.messages || [];
    // Bounded fan-out: one metadata get per row, capped at FANOUT_CONCURRENCY
    // in-flight, with transient retry; rows that 404 (deleted between list
    // and get) are skipped rather than failing the page.
    const results = await fanoutMap(
      messages,
      async (msg) => {
        const detail = await ctx.gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "To", "Cc", "Date"],
        }, apiOpts(ctx));
        const headers = detail.data.payload?.headers || [];
        const header = (name: string) => headers.find((h) => h.name === name)?.value || "";
        const from = header("From");
        return {
          id: msg.id ?? null,
          // msg.threadId is already present on the messages.list entry — no
          // extra RPC. Lets callers jump straight to get_thread.
          threadId: msg.threadId ?? null,
          subject: header("Subject"),
          from,
          fromAddress: lowerEmail(parseEmailAddress(from)),
          to: parseEmailAddresses(header("To")).map(lowerEmail),
          cc: parseEmailAddresses(header("Cc")).map(lowerEmail),
          date: header("Date"),
        };
      },
      { label: "gmail_search_fanout" },
    );

    const structured: SearchEmailsOutput = {
      resultCount: results.length,
      results,
      ...listMeta(results.length, {
        estimate: response.data.resultSizeEstimate,
        nextPageToken: response.data.nextPageToken,
      }),
    };
    if (response.data.nextPageToken) {
      structured.nextPageToken = response.data.nextPageToken;
    }
    if (typeof response.data.resultSizeEstimate === "number") {
      structured.resultSizeEstimate = response.data.resultSizeEstimate;
    }

    return {
      content: [
        {
          type: "text",
          text: results
            .map((r) => `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`)
            .join("\n"),
        },
      ],
      structuredContent: structured,
    };
  },
};

const modifyEmail: Operation<unknown, ModifyOrDeleteEmailOutput> = {
  name: "modify_email",
  schema: ModifyEmailSchema,
  outputSchema: ModifyOrDeleteEmailOutputSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as {
      messageId: string;
      labelIds?: string[];
      addLabelIds?: string[];
      removeLabelIds?: string[];
    };

    // Match the legacy precedence: explicit addLabelIds wins over the
    // deprecated `labelIds` field; removeLabelIds is always honored.
    const requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
    if (args.labelIds) requestBody.addLabelIds = args.labelIds;
    if (args.addLabelIds) requestBody.addLabelIds = args.addLabelIds;
    if (args.removeLabelIds) requestBody.removeLabelIds = args.removeLabelIds;

    await ctx.gmail.users.messages.modify({
      userId: "me",
      id: args.messageId,
      requestBody,
    }, apiOpts(ctx));

    return {
      content: [{ type: "text", text: `Email ${args.messageId} labels updated successfully` }],
      structuredContent: { messageId: args.messageId, status: "modified" },
    };
  },
};

const deleteEmail: Operation<unknown, ModifyOrDeleteEmailOutput> = {
  name: "delete_email",
  schema: DeleteEmailSchema,
  outputSchema: ModifyOrDeleteEmailOutputSchema,
  scopes: ["gmail.full"],
  handler: async (input, ctx) => {
    const args = input as { messageId: string };
    await ctx.gmail.users.messages.delete({
      userId: "me",
      id: args.messageId,
    }, apiOpts(ctx));
    return {
      content: [{ type: "text", text: `Email ${args.messageId} deleted successfully` }],
      structuredContent: { messageId: args.messageId, status: "deleted" },
    };
  },
};

const reportPhishing: Operation<unknown, ReportPhishingOutput> = {
  name: "report_phishing",
  schema: ReportPhishingSchema,
  outputSchema: ReportPhishingOutputSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const { messageId } = input as z.infer<typeof ReportPhishingSchema>;
    await ctx.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { addLabelIds: ["SPAM"] },
    }, apiOpts(ctx));
    const limitation =
      "Gmail exposes no native phishing-report endpoint; this operation applies the SPAM label.";
    return {
      content: [
        {
          type: "text",
          text: `Email ${messageId} marked as spam. ${limitation}`,
        },
      ],
      structuredContent: {
        messageId,
        labelApplied: "SPAM",
        status: "reported_as_spam",
        limitation,
      },
    };
  },
};

registry.register(readEmail);
registry.register(searchEmails);
registry.register(modifyEmail);
registry.register(deleteEmail);
registry.register(reportPhishing);
