import { z } from 'zod';

/**
 * Whether saved notes are sorted onto pages: `off` does nothing, `report` asks the model and only records what it
 * would have done, `on` writes the pages and the list of handled notes.
 */
export const PageSortModeSchema = z.enum(['off', 'report', 'on']);
export type PageSortMode = z.infer<typeof PageSortModeSchema>;
