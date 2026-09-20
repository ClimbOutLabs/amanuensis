// Zod schemas mirroring the subset of `googleapis` gmail_v1 response shapes
// the ops in src/core/ops/ actually consume. Used as the on-disk fixture
// contract — every fixture JSON file is parsed through one of these before
// the fake gmail client returns it, so a typo in a hand-written fixture (or
// drift after a googleapis bump) surfaces as a clear validation error at the
// fixture boundary instead of a cryptic null-deref deep in an op handler.
//
// `.passthrough()` is used everywhere so unrecognised fields don't trip the
// parse — we mirror what we *read*, not the entire gmail_v1 surface. If a
// real-Gmail response carries fields we don't list here, it still passes.

import { z } from "zod";

// ── Message structure ────────────────────────────────────────────────────────

export const MessagePartHeaderSchema = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .passthrough();

export const MessagePartBodySchema = z
  .object({
    attachmentId: z.string().optional(),
    size: z.number().optional(),
    data: z.string().optional(),
  })
  .passthrough();

// MessagePart is recursive (nested multipart). `z.lazy` defers the reference
// so the child reference resolves at parse-time, not module-load.
interface MessagePartShape {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: z.infer<typeof MessagePartHeaderSchema>[];
  body?: z.infer<typeof MessagePartBodySchema>;
  parts?: MessagePartShape[];
};

export const MessagePartSchema: z.ZodType<MessagePartShape> = z.lazy(() =>
  z
    .object({
      partId: z.string().optional(),
      mimeType: z.string().optional(),
      filename: z.string().optional(),
      headers: z.array(MessagePartHeaderSchema).optional(),
      body: MessagePartBodySchema.optional(),
      parts: z.array(MessagePartSchema).optional(),
    })
    .passthrough(),
);

export const MessageSchema = z
  .object({
    id: z.string().optional(),
    threadId: z.string().optional(),
    labelIds: z.array(z.string()).optional(),
    snippet: z.string().optional(),
    historyId: z.string().optional(),
    internalDate: z.string().optional(),
    payload: MessagePartSchema.optional(),
    sizeEstimate: z.number().optional(),
    raw: z.string().optional(),
  })
  .passthrough();

export const MessageStubSchema = z
  .object({
    id: z.string(),
    threadId: z.string().optional(),
  })
  .passthrough();

export const ListMessagesResponseSchema = z
  .object({
    messages: z.array(MessageStubSchema).optional(),
    nextPageToken: z.string().optional(),
    resultSizeEstimate: z.number().optional(),
  })
  .passthrough();

// ── Thread structure ─────────────────────────────────────────────────────────

export const ThreadSchema = z
  .object({
    id: z.string().optional(),
    snippet: z.string().optional(),
    historyId: z.string().optional(),
    messages: z.array(MessageSchema).optional(),
  })
  .passthrough();

export const ThreadStubSchema = z
  .object({
    id: z.string(),
    historyId: z.string().optional(),
    snippet: z.string().optional(),
  })
  .passthrough();

export const ListThreadsResponseSchema = z
  .object({
    threads: z.array(ThreadStubSchema).optional(),
    nextPageToken: z.string().optional(),
    resultSizeEstimate: z.number().optional(),
  })
  .passthrough();

// ── Labels ───────────────────────────────────────────────────────────────────

export const LabelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    messageListVisibility: z.enum(["show", "hide"]).optional(),
    labelListVisibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
    type: z.enum(["system", "user"]).optional(),
    messagesTotal: z.number().optional(),
    messagesUnread: z.number().optional(),
    threadsTotal: z.number().optional(),
    threadsUnread: z.number().optional(),
    color: z
      .object({
        textColor: z.string().optional(),
        backgroundColor: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

export const ListLabelsResponseSchema = z
  .object({
    labels: z.array(LabelSchema).optional(),
  })
  .passthrough();

// ── Filters ──────────────────────────────────────────────────────────────────

export const FilterCriteriaSchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    query: z.string().optional(),
    negatedQuery: z.string().optional(),
    hasAttachment: z.boolean().optional(),
    excludeChats: z.boolean().optional(),
    size: z.number().optional(),
    sizeComparison: z.enum(["unspecified", "smaller", "larger"]).optional(),
  })
  .passthrough();

export const FilterActionSchema = z
  .object({
    addLabelIds: z.array(z.string()).optional(),
    removeLabelIds: z.array(z.string()).optional(),
    forward: z.string().optional(),
  })
  .passthrough();

export const FilterSchema = z
  .object({
    id: z.string(),
    criteria: FilterCriteriaSchema.optional(),
    action: FilterActionSchema.optional(),
  })
  .passthrough();

export const ListFiltersResponseSchema = z
  .object({
    filter: z.array(FilterSchema).optional(),
  })
  .passthrough();

// ── Send-as / forwarding settings ────────────────────────────────────────────

export const SendAsSchema = z
  .object({
    sendAsEmail: z.string(),
    displayName: z.string().optional(),
    replyToAddress: z.string().optional(),
    isDefault: z.boolean().optional(),
    isPrimary: z.boolean().optional(),
    treatAsAlias: z.boolean().optional(),
    verificationStatus: z.string().optional(),
  })
  .passthrough();

export const ListSendAsResponseSchema = z
  .object({
    sendAs: z.array(SendAsSchema).optional(),
  })
  .passthrough();

export const ForwardingAddressSchema = z
  .object({
    forwardingEmail: z.string(),
    verificationStatus: z.string().optional(),
  })
  .passthrough();

export const ListForwardingResponseSchema = z
  .object({
    forwardingAddresses: z.array(ForwardingAddressSchema).optional(),
  })
  .passthrough();

// ── Profile ──────────────────────────────────────────────────────────────────

export const ProfileSchema = z
  .object({
    emailAddress: z.string(),
    messagesTotal: z.number().optional(),
    threadsTotal: z.number().optional(),
    historyId: z.string().optional(),
  })
  .passthrough();

// ── Drafts ───────────────────────────────────────────────────────────────────

export const DraftSchema = z
  .object({
    id: z.string(),
    message: MessageSchema.optional(),
  })
  .passthrough();

export const ListDraftsResponseSchema = z
  .object({
    drafts: z.array(DraftSchema).optional(),
    nextPageToken: z.string().optional(),
    resultSizeEstimate: z.number().optional(),
  })
  .passthrough();

// ── Attachments ──────────────────────────────────────────────────────────────

export const AttachmentBodySchema = z
  .object({
    attachmentId: z.string().optional(),
    size: z.number().optional(),
    data: z.string(), // base64url-encoded
  })
  .passthrough();

// ── Convenience type exports ─────────────────────────────────────────────────

export type Message = z.infer<typeof MessageSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type Label = z.infer<typeof LabelSchema>;
export type Filter = z.infer<typeof FilterSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type ListDraftsResponse = z.infer<typeof ListDraftsResponseSchema>;
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;
export type ListThreadsResponse = z.infer<typeof ListThreadsResponseSchema>;
export type ListLabelsResponse = z.infer<typeof ListLabelsResponseSchema>;
export type ListFiltersResponse = z.infer<typeof ListFiltersResponseSchema>;
