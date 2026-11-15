import { z } from 'zod';

import { isMemoryNoteSource } from '../../../../src/runtime/memory/memoryNotes';
import { TOOL_INGESTED_ORIGIN, USER_STATED_ORIGIN } from '../../../../src/runtime/memory/memoryOrigin';
import { ExpectedDecisionSchema, PageSlugSchema } from '../decisionSchema';

/** Days the world runs for. Day 1 is 2026-08-01. */
export const MAYA_WORLD_DAYS = 60;

const DaySchema = z.number().int().min(1).max(MAYA_WORLD_DAYS);

const entryBase = {
  /** `d07_e03`: day 7, entry 3. */
  id: z.string().regex(/^d\d{2}_e\d{2}$/),
  day: DaySchema,
  timestamp: z.iso.datetime(),
  /** The chat the entry was written in. Entries of one chat share it. */
  session: z.string().regex(/^[a-z0-9-]+$/),
  content: z.string().min(1),
  /** May be empty: nothing in the entry is worth a page. */
  expected: z.array(ExpectedDecisionSchema),
};

const SaidEntrySchema = z.strictObject({ ...entryBase, origin: z.literal(USER_STATED_ORIGIN) });

const ReadEntrySchema = z.strictObject({
  ...entryBase,
  origin: z.literal(TOOL_INGESTED_ORIGIN),
  note_source: z.string().refine(isMemoryNoteSource, 'must be a note source'),
});

/** One daily-log entry of the world, with what sorting it into pages should decide. */
export const MayaEntrySchema = z.discriminatedUnion('origin', [SaidEntrySchema, ReadEntrySchema]);
export type MayaEntry = z.infer<typeof MayaEntrySchema>;

/** Something that happens to the vault outside the daily log. */
export const MayaEventSchema = z.strictObject({
  day: DaySchema,
  kind: z.literal('hand_edit'),
  about: PageSlugSchema,
  /** The line as it stood, or null when the person wrote a new line. */
  before_line: z.string().min(1).nullable(),
  after_line: z.string().min(1),
});
export type MayaEvent = z.infer<typeof MayaEventSchema>;

export const RECALL_CATEGORIES = [
  'current_value_of_changed_fact',
  'relationship',
  'household_plan',
  'how_you_write_to_them',
  'temporary_fact',
  'earlier_fact',
  'matter_status',
  'unconfirmed_claim',
  'no_name_in_message',
  'asked_in_other_words',
  'nothing_to_recall',
] as const;

/** One thing the person asks, and what the memory shown to the model must then hold. */
export const RecallQuestionSchema = z
  .strictObject({
    id: z.string().regex(/^q\d{2}$/),
    /** The day the question is asked; the vault holds days 1 to this one. */
    as_of_day: DaySchema,
    /** What the person typed earlier in the same chat, oldest first. */
    earlier_messages: z.array(z.string().min(1)).default([]),
    message: z.string().min(1),
    category: z.enum(RECALL_CATEGORIES),
    /** Must appear in the memory block. Left out only when nothing in memory should be shown. */
    expected_text: z.string().min(1).optional(),
    /** The same answer in the words a page states it in. The answer also counts as found when every one of these is in the block. */
    page_wording: z.array(z.string().min(1)).min(1).optional(),
    /** A stale or unwanted value that should not be put in front of the model. */
    must_not_text: z.string().min(1).optional(),
    /** The entries, or `event:<day>` for a hand edit, that justify the answer. Empty when the vault holds nothing on the subject. */
    source_entry_ids: z.array(z.string().min(1)),
  })
  .refine(
    question =>
      question.category === 'nothing_to_recall'
        ? question.expected_text === undefined &&
          question.must_not_text === undefined &&
          question.source_entry_ids.length === 0
        : (question.expected_text !== undefined || question.must_not_text !== undefined) &&
          question.source_entry_ids.length > 0,
    {
      message:
        'A question needs a text to find or a text to keep out, and the entries that justify it. A message with nothing to recall names none of them.',
    },
  );
export type RecallQuestion = z.infer<typeof RecallQuestionSchema>;
