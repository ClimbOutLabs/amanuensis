import { z } from 'zod';

import { FactMarkerSchema } from '../../../src/runtime/memory/memoryNotes';
import { PageKindSchema, PageSectionSchema } from '../../../src/runtime/memory/memoryPages';
import { isPageSlug } from '../../../src/runtime/memory/pageSlug';

/** The page a decision is about, as the slug its file is named by. */
export const PageSlugSchema = z.string().refine(isPageSlug, 'must be a page slug');

/** A day at the precision a fact marker allows. */
export const FactDaySchema = FactMarkerSchema.shape.since.unwrap();

const reason = z.string().min(1);

const NewDecisionSchema = z.strictObject({
  decision: z.literal('new'),
  about: PageSlugSchema,
  page_kind: PageKindSchema,
  // Anything on probation is an `unconfirmed` decision, so a new fact never lands there.
  section: PageSectionSchema.exclude(['Unconfirmed']),
  text: z.string().min(1),
  since: FactDaySchema.optional(),
  until: FactDaySchema.optional(),
  reason,
});

const SameDecisionSchema = z.strictObject({
  decision: z.literal('same'),
  about: PageSlugSchema,
  matches_text: z.string().min(1),
  reason,
});

const ChangedDecisionSchema = z.strictObject({
  decision: z.literal('changed'),
  about: PageSlugSchema,
  old_text: z.string().min(1),
  new_text: z.string().min(1),
  until_old: FactDaySchema,
  since_new: FactDaySchema,
  reason,
});

const EndedDecisionSchema = z.strictObject({
  decision: z.literal('ended'),
  about: PageSlugSchema,
  old_text: z.string().min(1),
  until: FactDaySchema,
  reason,
});

const UnconfirmedDecisionSchema = z.strictObject({
  decision: z.literal('unconfirmed'),
  about: PageSlugSchema,
  page_kind: PageKindSchema,
  text: z.string().min(1),
  seen: FactDaySchema,
  reason,
});

const IgnoreDecisionSchema = z.strictObject({
  decision: z.literal('ignore'),
  reason,
});

/** What should happen to the pages when one daily-log entry is sorted. */
export const ExpectedDecisionSchema = z.discriminatedUnion('decision', [
  NewDecisionSchema,
  SameDecisionSchema,
  ChangedDecisionSchema,
  EndedDecisionSchema,
  UnconfirmedDecisionSchema,
  IgnoreDecisionSchema,
]);
export type ExpectedDecision = z.infer<typeof ExpectedDecisionSchema>;
