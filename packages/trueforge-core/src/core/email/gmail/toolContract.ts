/**
 * Canonical owner of the Gmail tool contract: names, parameter schemas and annotations. Parameter names keep
 * Gmail's own camelCase because the tools stand in for a third-party mail surface; the wire-shape rule for
 * this API does not apply to them.
 */
import { z } from 'zod';

export const GMAIL_SERVER_ID = 'gmail';

export const LIST_INBOX_THREADS_TOOL_NAME = 'list_inbox_threads';
export const GET_THREAD_TOOL_NAME = 'get_thread';
export const READ_EMAIL_TOOL_NAME = 'read_email';
export const DOWNLOAD_ATTACHMENT_TOOL_NAME = 'download_attachment';
export const LIST_DRAFTS_TOOL_NAME = 'list_drafts';
export const GET_DRAFT_TOOL_NAME = 'get_draft';
export const DRAFT_EMAIL_TOOL_NAME = 'draft_email';
export const UPDATE_DRAFT_TOOL_NAME = 'update_draft';
export const SEND_DRAFT_TOOL_NAME = 'send_draft';

export const GMAIL_READ_TOOL_NAMES = [
  LIST_INBOX_THREADS_TOOL_NAME,
  GET_THREAD_TOOL_NAME,
  READ_EMAIL_TOOL_NAME,
  DOWNLOAD_ATTACHMENT_TOOL_NAME,
  LIST_DRAFTS_TOOL_NAME,
  GET_DRAFT_TOOL_NAME,
] as const;

export const GMAIL_WRITE_TOOL_NAMES = [DRAFT_EMAIL_TOOL_NAME, UPDATE_DRAFT_TOOL_NAME, SEND_DRAFT_TOOL_NAME] as const;

export function isGmailReadToolName(tool_name: string): boolean {
  return GMAIL_READ_TOOL_NAMES.some(name => name === tool_name);
}

export function isGmailWriteToolName(tool_name: string): boolean {
  return GMAIL_WRITE_TOOL_NAMES.some(name => name === tool_name);
}

export const MAX_RESULTS_CAP = 100;
export const DEFAULT_MAX_RESULTS = 50;

const id = z.string().min(1).max(128);

export const ListInboxThreadsSchema = z
  .object({
    query: z.string().max(256).default('in:inbox'),
    maxResults: z.number().int().min(1).max(MAX_RESULTS_CAP).default(DEFAULT_MAX_RESULTS),
    pageToken: z.string().max(512).optional(),
  })
  .strict();

export const GetThreadSchema = z
  .object({
    threadId: id.optional(),
    messageId: id.optional(),
    format: z.enum(['full', 'metadata', 'minimal']).default('full'),
  })
  .strict()
  .refine(value => (value.threadId === undefined) !== (value.messageId === undefined), {
    message: 'Provide exactly one of threadId or messageId',
  });

export const ReadEmailSchema = z.object({ messageId: id }).strict();

export const DownloadAttachmentSchema = z.object({ messageId: id, attachmentId: z.string().min(1).max(512) }).strict();

export const ListDraftsSchema = z
  .object({
    maxResults: z.number().int().min(1).max(MAX_RESULTS_CAP).default(DEFAULT_MAX_RESULTS),
    pageToken: z.string().max(512).optional(),
  })
  .strict();

export const DraftIdSchema = z.object({ draftId: id }).strict();

const DraftContentShape = {
  to: z.array(z.email()).min(1).max(20),
  subject: z.string().min(1).max(300),
  body: z.string().max(20_000),
  cc: z.array(z.email()).max(20).optional(),
  bcc: z.array(z.email()).max(20).optional(),
  threadId: id.optional(),
  inReplyTo: id.optional(),
};

export const DraftEmailSchema = z.object(DraftContentShape).strict();
export const UpdateDraftSchema = z.object({ draftId: id, ...DraftContentShape }).strict();

export type DraftContent = z.infer<typeof DraftEmailSchema>;

/**
 * Mail text is attacker-controlled, so every read is open-world: the tool-output screen looks at it and the
 * classifier treats a turn that read mail as one that holds private data.
 */
export const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
