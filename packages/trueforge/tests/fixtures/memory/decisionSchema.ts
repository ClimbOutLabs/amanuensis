import { z } from 'zod';

import {
  ChangedDecisionSchema,
  EndedDecisionSchema,
  FactDaySchema,
  IgnoreDecisionSchema,
  NewDecisionSchema,
  PageSlugSchema,
  SameDecisionSchema,
  UnconfirmedDecisionSchema,
} from '../../../src/runtime/memory/pageSortDecisions';

export { FactDaySchema, PageSlugSchema };

/**
 * What should happen to the pages when one daily-log entry is sorted. These are the sorter's decisions with one
 * change: an existing statement is named by its words, because the story is written before any page has ids.
 * `statementIds` turns the words into ids for scoring.
 */
export const ExpectedDecisionSchema = z.discriminatedUnion('decision', [
  NewDecisionSchema.omit({ title: true }),
  SameDecisionSchema.omit({ statement_id: true }).extend({ matches_text: z.string().min(1) }),
  ChangedDecisionSchema.omit({ statement_id: true }).extend({ old_text: z.string().min(1) }),
  EndedDecisionSchema.omit({ statement_id: true }).extend({ old_text: z.string().min(1) }),
  UnconfirmedDecisionSchema.omit({ title: true }),
  IgnoreDecisionSchema,
]);
export type ExpectedDecision = z.infer<typeof ExpectedDecisionSchema>;
