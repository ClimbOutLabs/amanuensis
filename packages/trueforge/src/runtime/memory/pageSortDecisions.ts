/**
 * The decisions the sorter's model answers with for one saved note. Canonical owner of their shape: a statement
 * that already exists is named by the id the prompt showed, never by its text.
 */
import { z } from 'zod';

import { FactMarkerSchema } from './memoryNotes';
import { PageKindSchema, PageSectionSchema } from './memoryPages';
import { isPageSlug } from './pageSlug';

/** Most decisions one note may get; a longer list is refused whole. */
export const SORT_MAX_DECISIONS = 8;

/** The page a decision is about, as the slug its file is named by. */
export const PageSlugSchema = z.string().refine(isPageSlug, 'must be a page slug');

/** A day at the precision a fact marker allows. */
export const FactDaySchema = FactMarkerSchema.shape.since.unwrap();

const reason = z.string().min(1);

/** The id the prompt shows beside a statement. */
export const StatementIdSchema = z.string().min(1).max(80);

export const NewDecisionSchema = z.strictObject({
  decision: z.literal('new'),
  about: PageSlugSchema,
  page_kind: PageKindSchema,
  /** What to call a page that does not exist yet. */
  title: z.string().min(1).optional(),
  // Anything on probation is an `unconfirmed` decision, so a new fact never lands there.
  section: PageSectionSchema.exclude(['Unconfirmed']),
  text: z.string().min(1),
  since: FactDaySchema.optional(),
  until: FactDaySchema.optional(),
  reason,
});

export const SameDecisionSchema = z.strictObject({
  decision: z.literal('same'),
  about: PageSlugSchema,
  statement_id: StatementIdSchema,
  reason,
});

export const ChangedDecisionSchema = z.strictObject({
  decision: z.literal('changed'),
  about: PageSlugSchema,
  statement_id: StatementIdSchema,
  new_text: z.string().min(1),
  until_old: FactDaySchema,
  since_new: FactDaySchema,
  reason,
});

export const EndedDecisionSchema = z.strictObject({
  decision: z.literal('ended'),
  about: PageSlugSchema,
  statement_id: StatementIdSchema,
  until: FactDaySchema,
  reason,
});

export const UnconfirmedDecisionSchema = z.strictObject({
  decision: z.literal('unconfirmed'),
  about: PageSlugSchema,
  page_kind: PageKindSchema,
  title: z.string().min(1).optional(),
  text: z.string().min(1),
  seen: FactDaySchema,
  reason,
});

export const IgnoreDecisionSchema = z.strictObject({
  decision: z.literal('ignore'),
  reason,
});

/** What should happen to the pages when one daily-log note is sorted. */
export const SortDecisionSchema = z.discriminatedUnion('decision', [
  NewDecisionSchema,
  SameDecisionSchema,
  ChangedDecisionSchema,
  EndedDecisionSchema,
  UnconfirmedDecisionSchema,
  IgnoreDecisionSchema,
]);
export type SortDecision = z.infer<typeof SortDecisionSchema>;

/** The model's whole reply. */
export const SortReplySchema = z.strictObject({
  decisions: z.array(SortDecisionSchema).max(SORT_MAX_DECISIONS),
});
