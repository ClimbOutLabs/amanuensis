/**
 * Canonical owner of the Gmail tool contract: names, parameter schemas and annotations. Parameters are
 * snake_case like the sandbox tools; the mapping onto Gmail's own field names stays inside the API client.
 */
import { z } from 'zod';
import { countIdeographicSelectors, hasHiddenCharacters, MAX_IDEOGRAPHIC_SELECTORS } from './mimeText';

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
    max_results: z.number().int().min(1).max(MAX_RESULTS_CAP).default(DEFAULT_MAX_RESULTS),
    page_token: z.string().max(512).optional(),
  })
  .strict();

export const GetThreadSchema = z
  .object({
    thread_id: id.optional(),
    message_id: id.optional(),
    format: z.enum(['full', 'metadata', 'minimal']).default('full'),
  })
  .strict()
  .refine(value => (value.thread_id === undefined) !== (value.message_id === undefined), {
    message: 'Provide exactly one of thread_id or message_id',
  });

export const ReadEmailSchema = z.object({ message_id: id }).strict();

export const DownloadAttachmentSchema = z
  .object({ message_id: id, attachment_id: z.string().min(1).max(512) })
  .strict();

export const ListDraftsSchema = z
  .object({
    max_results: z.number().int().min(1).max(MAX_RESULTS_CAP).default(DEFAULT_MAX_RESULTS),
    page_token: z.string().max(512).optional(),
  })
  .strict();

export const DraftIdSchema = z.object({ draft_id: id }).strict();

const VISIBLE_ONLY = {
  message:
    'The text contains characters that do not show, such as hidden Unicode tags or zero-width marks. Remove them.',
};

/** Text that is shown to the user must be text they can see: a send is refused if part of it would be hidden. */
const visible = <T extends z.ZodType<string>>(schema: T) =>
  schema.refine(text => !hasHiddenCharacters(text), VISIBLE_ONLY);

const DraftContentShape = {
  to: z.array(visible(z.email())).min(1).max(20),
  subject: visible(z.string().min(1).max(300)),
  body: visible(z.string().max(20_000)),
  cc: z.array(visible(z.email())).max(20).optional(),
  bcc: z.array(visible(z.email())).max(20).optional(),
  thread_id: id.optional(),
  in_reply_to: id.optional(),
};

/** A draft may carry only a few ideographic variation selectors, so it stays one Aman can send. */
const fewSelectors = (draft: { subject: string; body: string }) =>
  countIdeographicSelectors(draft.subject) + countIdeographicSelectors(draft.body) <= MAX_IDEOGRAPHIC_SELECTORS;
const TOO_MANY_SELECTORS = { message: 'The text has more variation selectors than a name or word needs. Remove them.' };

export const DraftEmailSchema = z.object(DraftContentShape).strict().refine(fewSelectors, TOO_MANY_SELECTORS);
export const UpdateDraftSchema = z
  .object({ draft_id: id, ...DraftContentShape })
  .strict()
  .refine(fewSelectors, TOO_MANY_SELECTORS);

export type DraftContent = z.infer<typeof DraftEmailSchema>;

/**
 * Mail text is attacker-controlled, so every read is open-world: the tool-output screen looks at it and the
 * classifier treats a turn that read mail as one that holds private data.
 */
export const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
