import { z } from '@hono/zod-openapi';
import { FactMarkerSchema } from '../runtime/memory/memoryNotes';
import { PageKindSchema, PageSectionSchema } from '../runtime/memory/memoryPages';
import { PAGE_COMMIT_ID_PATTERN } from '../runtime/memory/vaultGit';

/** Most characters of Markdown one saved page may have. */
export const MAX_PAGE_MARKDOWN_CHARS = 60_000;

/** Where a line came from. `unreadable` is a line whose hidden note Aman cannot read. */
export const MemoryPageLineSourceSchema = z.enum([...FactMarkerSchema.shape.src.options, 'unreadable']);

export type MemoryPageLineSource = z.infer<typeof MemoryPageLineSourceSchema>;

/** One page in the list. */
export const MemoryPageSummarySchema = z
  .object({
    kind: PageKindSchema,
    slug: z.string(),
    title: z.string(),
    other_names: z.array(z.string()),
    summary: z.string().nullable().describe('The line under the title, or null when the page has none.'),
    changed_on: z.string().nullable().describe('The day the page file last changed, as `YYYY-MM-DD` in UTC.'),
    unconfirmed_count: z.number().int().min(0).describe('Lines waiting under Unconfirmed.'),
    disagreement_count: z.number().int().min(0).describe('Pairs of lines the nightly check found that disagree.'),
  })
  .openapi('MemoryPageSummary');

export type MemoryPageSummary = z.infer<typeof MemoryPageSummarySchema>;

/** The page list, and the page files that could not be read as pages. */
export const MemoryPageListingSchema = z
  .object({
    pages: z.array(MemoryPageSummarySchema),
    skipped_files: z.array(z.string()).describe('Files in the page folders whose names are not page names.'),
  })
  .openapi('MemoryPageListing');

export type MemoryPageListing = z.infer<typeof MemoryPageListingSchema>;

export const ListMemoryPagesResponseSchema = z
  .object({ data: MemoryPageListingSchema })
  .openapi('ListMemoryPagesResponse');

/** One line of a page with where it came from and whether it counts as the person's own. */
export const MemoryPageLineSchema = z
  .object({
    id: z.string().nullable().describe('The line id, or null for a line typed by hand that has none yet.'),
    text: z.string(),
    source: MemoryPageLineSourceSchema,
    source_label: z.string().describe('Where the line came from, in plain words.'),
    own: z.boolean().describe('True when the line is the person’s own words.'),
    since: z.string().nullable(),
    until: z.string().nullable(),
    seen: z.string().nullable(),
  })
  .openapi('MemoryPageLine');

export type MemoryPageLine = z.infer<typeof MemoryPageLineSchema>;

export const MemoryPageSectionSchema = z
  .object({
    name: z.string().describe('The section heading as written.'),
    lines: z.array(MemoryPageLineSchema),
  })
  .openapi('MemoryPageSection');

/** One of the two lines in a pair that disagree. */
export const MemoryPageDisagreementLineSchema = z
  .object({ id: z.string(), text: z.string() })
  .openapi('MemoryPageDisagreementLine');

/** Two lines of a page that cannot both be true now. Nothing on the page changed. */
export const MemoryPageDisagreementSchema = z
  .object({
    id: z.string().describe('Name the pair with this id when dismissing it.'),
    first: MemoryPageDisagreementLineSchema,
    second: MemoryPageDisagreementLineSchema,
    reason: z.string().describe('Why they disagree, in one short line.'),
    found_on: z.string().describe('The day the pair was found, as `YYYY-MM-DD`.'),
  })
  .openapi('MemoryPageDisagreement');

export type MemoryPageDisagreement = z.infer<typeof MemoryPageDisagreementSchema>;

/** The section a confirmed line moves to. */
export const ConfirmableMemoryPageSectionSchema = PageSectionSchema.exclude(['Unconfirmed', 'Earlier']);

/** One page: its sections in order, and its text for the editor. */
export const MemoryPageSchema = z
  .object({
    kind: PageKindSchema,
    slug: z.string(),
    title: z.string(),
    other_names: z.array(z.string()),
    summary: z.string().nullable(),
    sections: z.array(MemoryPageSectionSchema),
    text: z
      .string()
      .describe('The page as a person edits it: its name, headings and lines, without settings or hidden notes.'),
    confirmable_sections: z
      .array(ConfirmableMemoryPageSectionSchema)
      .describe('The sections an unconfirmed line on this page can move to.'),
    version: z.string().describe('Send this back with an edit. It says which text the edit started from.'),
    disagreements: z
      .array(MemoryPageDisagreementSchema)
      .describe('Pairs of lines that disagree and are not dismissed.'),
  })
  .openapi('MemoryPage');

export type MemoryPage = z.infer<typeof MemoryPageSchema>;

export const GetMemoryPageResponseSchema = z.object({ data: MemoryPageSchema }).openapi('GetMemoryPageResponse');

/** The person's edited text for a page, and the version they started from. */
export const UpdateMemoryPageRequestSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(MAX_PAGE_MARKDOWN_CHARS)
      .describe('The edited page text. The first line names the page. A line left as it was keeps its source.'),
    version: z.string().min(1).max(128),
  })
  .openapi('UpdateMemoryPageRequest');

export const ConfirmMemoryPageLineRequestSchema = z
  .object({
    section: ConfirmableMemoryPageSectionSchema.optional().describe('Where the line goes. Defaults to Now.'),
  })
  .openapi('ConfirmMemoryPageLineRequest');

export const DeleteMemoryPageResponseSchema = z.object({}).openapi('DeleteMemoryPageResponse');

/** A page named by kind and slug. */
export const MemoryPageRefSchema = z.object({ kind: PageKindSchema, slug: z.string() }).openapi('MemoryPageRef');

export type MemoryPageRef = z.infer<typeof MemoryPageRefSchema>;

/** One entry in the page history. */
export const MemoryPageChangeSchema = z
  .object({
    id: z.string().regex(PAGE_COMMIT_ID_PATTERN),
    changed_at: z.string(),
    message: z.string().describe('What changed, in plain words.'),
    pages: z.array(MemoryPageRefSchema),
    undo_blocked_by: z
      .string()
      .nullable()
      .describe('The message of a later change to the same pages that must be undone first, or null.'),
    is_undo: z.boolean().describe('Whether this entry undid an earlier change.'),
  })
  .openapi('MemoryPageChange');

export type MemoryPageChange = z.infer<typeof MemoryPageChangeSchema>;

/** The history is off when the server has no git. */
export const MemoryPageChangesSchema = z
  .object({
    available: z.boolean().describe('False when the server keeps no page history.'),
    changes: z.array(MemoryPageChangeSchema),
  })
  .openapi('MemoryPageChanges');

export const ListMemoryPageChangesResponseSchema = z
  .object({ data: MemoryPageChangesSchema })
  .openapi('ListMemoryPageChangesResponse');

export const MemoryPageUndoResultSchema = z
  .object({ pages: z.array(MemoryPageRefSchema) })
  .openapi('MemoryPageUndoResult');

export const UndoMemoryPageChangeResponseSchema = z
  .object({ data: MemoryPageUndoResultSchema })
  .openapi('UndoMemoryPageChangeResponse');
