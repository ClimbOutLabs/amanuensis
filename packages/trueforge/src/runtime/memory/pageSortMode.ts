import { z } from 'zod';

/**
 * Whether saved notes are sorted onto pages: `off` does nothing, `report` asks the model and only records what it
 * would have done, `on` writes the pages and the list of handled notes.
 */
export const PageSortModeSchema = z.enum(['off', 'report', 'on']);
export type PageSortMode = z.infer<typeof PageSortModeSchema>;

/**
 * Why a note was left unsorted, as one of a fixed set a person can be told. The detail stays in the log.
 */
export const SortStopCauseSchema = z.enum([
  'model_slow',
  'model_error',
  'reply_empty',
  'reply_cut_short',
  'reply_too_long',
  'reply_wrong_form',
  'reply_broke_rule',
  'note_empty',
  'pages_unreadable',
  'write_failed',
]);
export type SortStopCause = z.infer<typeof SortStopCauseSchema>;
