// Thread-level ops: get_thread, list_inbox_threads, get_inbox_with_threads,
// modify_thread. Lifted verbatim from src/index.ts switch.

import { withRetry } from "@george43g/robustness";
import type { z } from "zod";
import type { EmailAttachment } from "../../email-export.js";
import {
  GetInboxWithThreadsOutputSchema,
  GetInboxWithThreadsSchema,
  GetThreadOutputSchema,
  GetThreadSchema,
  ListInboxThreadsOutputSchema,
  ListInboxThreadsSchema,
  ModifyThreadOutputSchema,
  ModifyThreadSchema,
} from "../../tools.js";
import {
  extractEmailContent,
  type GmailMessagePart,
  listMeta,
  readableEmailBody,
} from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";
import { apiOpts } from "../api.js";
import { fanoutMap } from "../fanout.js";

type GetThreadOutput = z.infer<typeof GetThreadOutputSchema>;
type ListInboxThreadsOutput = z.infer<typeof ListInboxThreadsOutputSchema>;
type GetInboxWithThreadsOutput = z.infer<typeof GetInboxWithThreadsOutputSchema>;
type ModifyThreadOutput = z.infer<typeof ModifyThreadOutputSchema>;

/**
 * Walk a Gmail message payload and collect attachment metadata.
 * Local to threads.ts because the legacy code inlines this walk; it's
 * functionally equivalent to extractAttachments from core/email-helpers.ts.
 * Keeping the inline shape here preserves the exact JSON output (filename
 * fallback string format, mime/size defaults) that callers may depend on.
 */
function collectAttachmentMeta(payload: GmailMessagePart | undefined): EmailAttachment[] {
  const attachments: EmailAttachment[] = [];
  const walk = (part: GmailMessagePart) => {
    if (part.body?.attachmentId) {
      const filename = part.filename || `attachment-${part.body.attachmentId}`;
      attachments.push({
        id: part.body.attachmentId,
        filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      part.parts.forEach((subpart: GmailMessagePart) => {
        walk(subpart);
      });
    }
  };
  if (payload) walk(payload);
  return attachments;
}

const getThread: Operation<unknown, GetThreadOutput> = {
  name: "get_thread",
  schema: GetThreadSchema,
  outputSchema: GetThreadOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as {
      threadId?: string;
      messageId?: string;
      format?: "full" | "metadata" | "minimal";
    };

    // Accept a messageId as an alternative to threadId: resolve it to its
    // thread with a cheap `minimal` fetch (only .threadId is needed). This
    // removes the read_email round-trip callers otherwise need after a search.
    let threadId = args.threadId;
    if (!threadId && args.messageId) {
      const msg = await ctx.gmail.users.messages.get({
        userId: "me",
        id: args.messageId,
        format: "minimal",
      }, apiOpts(ctx));
      threadId = msg.data.threadId || undefined;
      if (!threadId) {
        throw new Error(`Could not resolve a threadId from message ${args.messageId}`);
      }
    }

    const threadResponse = await ctx.gmail.users.threads.get({
      userId: "me",
      id: threadId!,
      format: args.format || "full",
    }, apiOpts(ctx));

    const threadMessages = threadResponse.data.messages || [];
    const messagesOutput = threadMessages.map((msg) => {
      const headers = msg.payload?.headers || [];
      const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
      const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
      const to = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
      const cc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
      const bcc = headers.find((h) => h.name?.toLowerCase() === "bcc")?.value || "";
      const date = headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

      let body = "";
      if (args.format !== "minimal") {
        body = readableEmailBody(extractEmailContent((msg.payload as GmailMessagePart) || {}));
      }

      const attachments = collectAttachmentMeta(msg.payload as GmailMessagePart | undefined);

      return {
        messageId: msg.id || "",
        threadId: msg.threadId || "",
        from,
        to,
        cc,
        bcc,
        subject,
        date,
        body,
        labelIds: msg.labelIds || [],
        attachments: attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        })),
      };
    });

    const structured = {
      threadId: threadId!,
      messageCount: messagesOutput.length,
      messages: messagesOutput,
      // A thread is fully enumerated in one call — never truncated.
      ...listMeta(messagesOutput.length),
    };
    return {
      content: [{ type: "text", text: renderThreadTranscript(structured) }],
      structuredContent: structured,
    };
  },
};

const listInboxThreads: Operation<unknown, ListInboxThreadsOutput> = {
  name: "list_inbox_threads",
  schema: ListInboxThreadsSchema,
  outputSchema: ListInboxThreadsOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { query?: string; maxResults?: number; pageToken?: string };
    const threadsResponse = await withRetry(
      () =>
        ctx.gmail.users.threads.list({
          userId: "me",
          q: args.query || "in:inbox",
          maxResults: args.maxResults || 50,
          ...(args.pageToken ? { pageToken: args.pageToken } : {}),
        }, apiOpts(ctx)),
      { label: "gmail_threads_list" },
    );

    const threads = threadsResponse.data.threads || [];

    // Bounded fan-out (see core/fanout.ts): capped in-flight gets, transient
    // retry, 404 rows skipped.
    const threadDetails = await fanoutMap(
      threads,
      async (thread) => {
        const detail = await ctx.gmail.users.threads.get({
          userId: "me",
          id: thread.id!,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        }, apiOpts(ctx));

        const messages = detail.data.messages || [];
        const latestMessage = messages[messages.length - 1];
        const latestHeaders = latestMessage?.payload?.headers || [];

        return {
          threadId: thread.id || "",
          snippet: thread.snippet || "",
          historyId: thread.historyId || "",
          messageCount: messages.length,
          latestMessage: {
            from: latestHeaders.find((h) => h.name === "From")?.value || "",
            subject: latestHeaders.find((h) => h.name === "Subject")?.value || "",
            date: latestHeaders.find((h) => h.name === "Date")?.value || "",
          },
        };
      },
      { label: "gmail_list_threads_fanout" },
    );

    const structured: ListInboxThreadsOutput = {
      resultCount: threadDetails.length,
      threads: threadDetails,
      ...listMeta(threadDetails.length, {
        estimate: threadsResponse.data.resultSizeEstimate,
        nextPageToken: threadsResponse.data.nextPageToken,
      }),
    };
    if (threadsResponse.data.nextPageToken) {
      structured.nextPageToken = threadsResponse.data.nextPageToken;
    }
    if (typeof threadsResponse.data.resultSizeEstimate === "number") {
      structured.resultSizeEstimate = threadsResponse.data.resultSizeEstimate;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
      structuredContent: structured,
    };
  },
};

const getInboxWithThreads: Operation<unknown, GetInboxWithThreadsOutput> = {
  name: "get_inbox_with_threads",
  schema: GetInboxWithThreadsSchema,
  outputSchema: GetInboxWithThreadsOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { query?: string; maxResults?: number; expandThreads?: boolean };
    const threadsResponse = await withRetry(
      () =>
        ctx.gmail.users.threads.list({
          userId: "me",
          q: args.query || "in:inbox",
          maxResults: args.maxResults || 50,
        }, apiOpts(ctx)),
      { label: "gmail_threads_list" },
    );

    const threads = threadsResponse.data.threads || [];

    if (!args.expandThreads) {
      // Same as list_inbox_threads when expand=false
      const threadSummaries = await fanoutMap(
        threads,
        async (thread) => {
          const detail = await ctx.gmail.users.threads.get({
            userId: "me",
            id: thread.id!,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          }, apiOpts(ctx));

          const messages = detail.data.messages || [];
          const latestMessage = messages[messages.length - 1];
          const latestHeaders = latestMessage?.payload?.headers || [];

          return {
            threadId: thread.id || "",
            snippet: thread.snippet || "",
            historyId: thread.historyId || "",
            messageCount: messages.length,
            latestMessage: {
              from: latestHeaders.find((h) => h.name === "From")?.value || "",
              subject: latestHeaders.find((h) => h.name === "Subject")?.value || "",
              date: latestHeaders.find((h) => h.name === "Date")?.value || "",
            },
          };
        },
        { label: "gmail_inbox_threads_fanout" },
      );

      const summaryStructured = {
        resultCount: threadSummaries.length,
        threads: threadSummaries,
        ...listMeta(threadSummaries.length, {
          estimate: threadsResponse.data.resultSizeEstimate,
        }),
      };
      // Text is a compact human summary; the full per-thread metadata lives
      // only in structuredContent.
      const summaryText =
        `Found ${threadSummaries.length} thread(s):\n\n` +
        threadSummaries
          .map(
            (t) =>
              `Thread ${t.threadId} (${t.messageCount} message${t.messageCount === 1 ? "" : "s"}): ` +
              `${t.latestMessage.date} | ${t.latestMessage.from} | ${t.latestMessage.subject}`,
          )
          .join("\n");
      return {
        content: [{ type: "text", text: summaryText }],
        structuredContent: summaryStructured,
      };
    }

    // expandThreads: fetch full content per thread.
    //
    // This is the expensive path (one threads.get(format=full) per thread,
    // each carrying full bodies). Cap the number of expanded threads and the
    // messages kept per thread so a maxResults=500 call cannot turn into 500
    // full-thread fetches with unbounded bodies.
    const EXPAND_THREADS_MAX = 25;
    const EXPAND_MESSAGES_PER_THREAD_MAX = 50;
    const threadsToExpand = threads.slice(0, EXPAND_THREADS_MAX);
    const expandTruncated = threads.length > threadsToExpand.length;

    const expandedThreads = await fanoutMap(
      threadsToExpand,
      async (thread) => {
        const threadDetail = await ctx.gmail.users.threads.get({
          userId: "me",
          id: thread.id!,
          format: "full",
        }, apiOpts(ctx));

        const threadMessages = threadDetail.data.messages || [];
        const keptMessages = threadMessages.slice(0, EXPAND_MESSAGES_PER_THREAD_MAX);

        const messages = keptMessages.map((msg) => {
          const headers = msg.payload?.headers || [];
          const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
          const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
          const to = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
          const cc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
          const bcc = headers.find((h) => h.name?.toLowerCase() === "bcc")?.value || "";
          const date = headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

          const body = readableEmailBody(
            extractEmailContent((msg.payload as GmailMessagePart) || {}),
          );

          const attachments = collectAttachmentMeta(msg.payload as GmailMessagePart | undefined);

          return {
            messageId: msg.id || "",
            threadId: msg.threadId || "",
            from,
            to,
            cc,
            bcc,
            subject,
            date,
            body,
            labelIds: msg.labelIds || [],
            attachments: attachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mimeType: a.mimeType,
              size: a.size,
            })),
          };
        });

        return {
          threadId: thread.id || "",
          messageCount: threadMessages.length,
          messages,
          messagesTruncated: threadMessages.length > keptMessages.length,
        };
      },
      { label: "gmail_expand_threads_fanout" },
    );

    const expandedStructured = {
      resultCount: expandedThreads.length,
      threads: expandedThreads,
      expandTruncated,
      ...(expandTruncated
        ? { expandNote: `Expansion capped at ${EXPAND_THREADS_MAX} threads; refine query or paginate for more.` }
        : {}),
      ...listMeta(expandedThreads.length, {
        estimate: threadsResponse.data.resultSizeEstimate,
      }),
    };
    // Text is a compact human summary — the full expanded payload lives only
    // in structuredContent (never duplicate the bodies in both).
    const expandedText =
      `Expanded ${expandedThreads.length} thread(s)` +
      (expandTruncated ? ` (capped at ${EXPAND_THREADS_MAX})` : "") +
      ":\n\n" +
      expandedThreads
        .map(
          (t) =>
            `Thread ${t.threadId} (${t.messageCount} message${t.messageCount === 1 ? "" : "s"}):\n` +
            t.messages
              .map((m) => `  - ${m.date} | ${m.from} | ${m.subject}`)
              .join("\n"),
        )
        .join("\n\n");
    return {
      content: [{ type: "text", text: expandedText }],
      structuredContent: expandedStructured,
    };
  },
};

const modifyThread: Operation<unknown, ModifyThreadOutput> = {
  name: "modify_thread",
  schema: ModifyThreadSchema,
  outputSchema: ModifyThreadOutputSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { threadId: string; addLabelIds?: string[]; removeLabelIds?: string[] };

    const modifyRequestBody: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
    if (args.addLabelIds) modifyRequestBody.addLabelIds = args.addLabelIds;
    if (args.removeLabelIds) modifyRequestBody.removeLabelIds = args.removeLabelIds;

    await ctx.gmail.users.threads.modify({
      userId: "me",
      id: args.threadId,
      requestBody: modifyRequestBody,
    }, apiOpts(ctx));

    return {
      content: [
        {
          type: "text",
          text: `Thread ${args.threadId} labels updated successfully (all messages in thread modified)`,
        },
      ],
      structuredContent: { threadId: args.threadId, status: "modified" },
    };
  },
};

registry.register(getThread);
registry.register(listInboxThreads);
registry.register(getInboxWithThreads);
registry.register(modifyThread);

function renderThreadTranscript(thread: GetThreadOutput): string {
  const messageNoun = thread.messageCount === 1 ? "message" : "messages";
  const lines = [`Thread ${thread.threadId} (${thread.messageCount} ${messageNoun})`];

  thread.messages.forEach((msg, index) => {
    if (index > 0) lines.push("");
    const subject = msg.subject || "(no subject)";
    lines.push(`--- Message ${index + 1}/${thread.messageCount}: ${subject}`);
    const accountId = (msg as { accountId?: string }).accountId;
    const emailAddress = (msg as { emailAddress?: string | null }).emailAddress;
    if (accountId) {
      lines.push(`Account: ${accountId}${emailAddress ? ` <${emailAddress}>` : ""}`);
    }
    lines.push(`From: ${msg.from}`);
    if (msg.to) lines.push(`To: ${msg.to}`);
    if (msg.cc) lines.push(`Cc: ${msg.cc}`);
    if (msg.bcc) lines.push(`Bcc: ${msg.bcc}`);
    if (msg.date) lines.push(`Date: ${msg.date}`);
    if (msg.labelIds.length > 0) lines.push(`Labels: ${msg.labelIds.join(", ")}`);
    if (msg.attachments.length > 0) {
      lines.push(
        `Attachments: ${msg.attachments
          .map((a) => `${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)} KB)`)
          .join(", ")}`,
      );
    }
    lines.push("");
    lines.push(msg.body || "(no body)");
  });

  return lines.join("\n");
}
