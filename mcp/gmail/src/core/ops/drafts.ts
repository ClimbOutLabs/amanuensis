// draft_email op — uses the shared handleEmailAction from send.ts.

import { withRetry } from "@george43g/robustness";
import type { z } from "zod";
import {
  DeleteDraftOutputSchema,
  DeleteDraftSchema,
  ListDraftsOutputSchema,
  ListDraftsSchema,
  SendDraftOutputSchema,
  SendDraftSchema,
  SendEmailSchema,
  SendOrDraftOutputSchema,
  UpdateDraftOutputSchema,
  UpdateDraftSchema,
} from "../../tools.js";
import { createEmailMessage, createEmailWithNodemailer, needsRawBuilder } from "../../utl.js";
import { extractHeaders, listMeta } from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";
import { handleEmailAction, type SendArgs, type SendOrDraftOutput } from "./send.js";
import { apiOpts } from "../api.js";
import { fanoutMap } from "../fanout.js";

type SendDraftOutput = z.infer<typeof SendDraftOutputSchema>;
type UpdateDraftOutput = z.infer<typeof UpdateDraftOutputSchema>;
type DeleteDraftOutput = z.infer<typeof DeleteDraftOutputSchema>;
type ListDraftsOutput = z.infer<typeof ListDraftsOutputSchema>;

const draftEmail: Operation<unknown, SendOrDraftOutput> = {
  name: "draft_email",
  schema: SendEmailSchema,
  outputSchema: SendOrDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose"],
  handler: async (input, ctx) => handleEmailAction("draft", input as SendArgs, ctx),
};

const sendDraft: Operation<unknown, SendDraftOutput> = {
  name: "send_draft",
  schema: SendDraftSchema,
  outputSchema: SendDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
  handler: async (input, ctx) => {
    const { draftId } = input as z.infer<typeof SendDraftSchema>;
    const response = await ctx.gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
    }, apiOpts(ctx));
    const structured: SendDraftOutput = {
      draftId,
      messageId: response.data.id ?? "",
      status: "sent",
    };
    if (response.data.threadId) structured.threadId = response.data.threadId;
    return {
      content: [
        {
          type: "text",
          text: `Draft ${draftId} sent successfully as message ${structured.messageId}. The draft was removed from Drafts.`,
        },
      ],
      structuredContent: structured,
    };
  },
};

const updateDraft: Operation<unknown, UpdateDraftOutput> = {
  name: "update_draft",
  schema: UpdateDraftSchema,
  outputSchema: UpdateDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose"],
  handler: async (input, ctx) => {
    const { draftId, ...messageArgs } = input as z.infer<typeof UpdateDraftSchema>;
    const message = needsRawBuilder(messageArgs)
      ? await createEmailWithNodemailer(messageArgs)
      : createEmailMessage(messageArgs);
    const raw = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const response = await ctx.gmail.users.drafts.update({
      userId: "me",
      id: draftId,
      requestBody: {
        message: {
          raw,
          ...(messageArgs.threadId ? { threadId: messageArgs.threadId } : {}),
        },
      },
    }, apiOpts(ctx));

    const structured: UpdateDraftOutput = {
      draftId: response.data.id ?? draftId,
      status: "updated",
    };
    if (response.data.message?.id) structured.messageId = response.data.message.id;
    if (response.data.message?.threadId) structured.threadId = response.data.message.threadId;
    return {
      content: [{ type: "text", text: `Draft ${structured.draftId} updated successfully.` }],
      structuredContent: structured,
    };
  },
};

const deleteDraft: Operation<unknown, DeleteDraftOutput> = {
  name: "delete_draft",
  schema: DeleteDraftSchema,
  outputSchema: DeleteDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose"],
  handler: async (input, ctx) => {
    const { draftId } = input as z.infer<typeof DeleteDraftSchema>;
    await ctx.gmail.users.drafts.delete({ userId: "me", id: draftId }, apiOpts(ctx));
    return {
      content: [{ type: "text", text: `Draft ${draftId} deleted successfully.` }],
      structuredContent: { draftId, status: "deleted" },
    };
  },
};

const listDrafts: Operation<unknown, ListDraftsOutput> = {
  name: "list_drafts",
  schema: ListDraftsSchema,
  outputSchema: ListDraftsOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const { maxResults, pageToken } = input as z.infer<typeof ListDraftsSchema>;
    const listRes = await withRetry(
      () =>
        ctx.gmail.users.drafts.list({
          userId: "me",
          ...(maxResults ? { maxResults } : {}),
          ...(pageToken ? { pageToken } : {}),
        }, apiOpts(ctx)),
      { label: "gmail_drafts_list" },
    );
    const stubs = listRes.data.drafts ?? [];

    // drafts.list returns lightweight stubs (draft id + message id/threadId).
    // Fetch metadata per draft to surface subject/recipients/snippet — the
    // N+1 the plan calls for; format:"metadata" keeps each get body-free.
    // Bounded fan-out: 404s (draft deleted between list and get) are skipped.
    const drafts: ListDraftsOutput["drafts"] = await fanoutMap(
      stubs,
      async (stub) => {
        const draftId = stub.id ?? "";
        const detail = await ctx.gmail.users.drafts.get({
          userId: "me",
          id: draftId,
          format: "metadata",
        }, apiOpts(ctx));
        const msg = detail.data.message;
        const headers = extractHeaders(msg?.payload);
        const to = headers.to
          ? headers.to
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : [];
        const summary: ListDraftsOutput["drafts"][number] = {
          draftId,
          messageId: msg?.id ?? stub.message?.id ?? "",
          subject: headers.subject,
          from: headers.from,
          to,
          date: headers.date,
          snippet: msg?.snippet ?? "",
        };
        const threadId = msg?.threadId ?? stub.message?.threadId;
        if (threadId) summary.threadId = threadId;
        return summary;
      },
      { label: "gmail_drafts_fanout" },
    );

    const meta = listMeta(drafts.length, {
      estimate: listRes.data.resultSizeEstimate,
      nextPageToken: listRes.data.nextPageToken,
    });
    const structured: ListDraftsOutput = {
      resultCount: drafts.length,
      drafts,
      truncated: meta.truncated,
      total_available: meta.total_available,
    };
    if (listRes.data.nextPageToken) structured.nextPageToken = listRes.data.nextPageToken;
    if (typeof listRes.data.resultSizeEstimate === "number") {
      structured.resultSizeEstimate = listRes.data.resultSizeEstimate;
    }

    const text = drafts.length
      ? `Found ${drafts.length} draft(s):\n${drafts
          .map(
            (d) =>
              `- ${d.draftId}: ${d.subject || "(no subject)"}${
                d.to.length ? ` → ${d.to.join(", ")}` : ""
              }`,
          )
          .join("\n")}`
      : "No drafts found.";

    return {
      content: [{ type: "text", text }],
      structuredContent: structured,
    };
  },
};

registry.register(draftEmail);
registry.register(sendDraft);
registry.register(updateDraft);
registry.register(deleteDraft);
registry.register(listDrafts);
