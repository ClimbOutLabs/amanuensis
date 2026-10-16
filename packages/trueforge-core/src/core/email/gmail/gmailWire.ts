/** The parts of Gmail's REST responses Aman reads. Fields Gmail may leave out are optional. */
import { z } from 'zod';

const HeaderSchema = z.object({ name: z.string(), value: z.string() });

export const MessagePartSchema = z.object({
  partId: z.string().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(HeaderSchema).optional(),
  body: z
    .object({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() })
    .optional(),
  get parts() {
    return z.array(MessagePartSchema).optional();
  },
});
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const GmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: MessagePartSchema.optional(),
});
export type GmailMessage = z.infer<typeof GmailMessageSchema>;

export const GmailThreadSchema = z.object({
  id: z.string(),
  messages: z.array(GmailMessageSchema).optional(),
});
export type GmailThread = z.infer<typeof GmailThreadSchema>;

export const ThreadListSchema = z.object({
  threads: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

export const DraftSchema = z.object({ id: z.string(), message: GmailMessageSchema.optional() });
export type GmailDraft = z.infer<typeof DraftSchema>;

export const DraftListSchema = z.object({
  drafts: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});

export const AttachmentBodySchema = z.object({ size: z.number().optional(), data: z.string().optional() });
