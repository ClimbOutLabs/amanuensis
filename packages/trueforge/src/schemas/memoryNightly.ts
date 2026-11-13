import { z } from '@hono/zod-openapi';

import { PageSortModeSchema, SortStopCauseSchema } from '../runtime/memory/pageSortMode';

export const MemoryNightlySchema = z
  .object({
    enabled: z
      .boolean()
      .describe('The stored setting: the persisted override when set, else the `MEMORY_NIGHTLY_JOB` env default.'),
    overridden: z.boolean().describe('Whether a persisted override is currently stored.'),
    default_enabled: z.boolean().describe('The `MEMORY_NIGHTLY_JOB` env default used when no override is stored.'),
    hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .describe("The hour of the server's day the tidy-up starts at. `0` is midnight, the default."),
    model_wait_minutes: z
      .number()
      .int()
      .min(1)
      .max(60)
      .describe('How many minutes one sorting or tidying question may wait for the model. `10` is the default.'),
  })
  .openapi('MemoryNightly');

export const UpdateMemoryNightlyRequestSchema = z
  .object({
    enabled: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        'Persisted override: `true` or `false`. `null` clears the override back to the env default. Left out, it stays as it is.',
      ),
    hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .optional()
      .describe("The hour of the server's day the tidy-up starts at, `0` to `23`. Left out, it stays as it is."),
    model_wait_minutes: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe(
        'Minutes one sorting or tidying question may wait for the model, `1` to `60`. Left out, it stays as it is.',
      ),
  })
  .openapi('UpdateMemoryNightlyRequest', { example: { enabled: true, hour: 0 } });

export const MemoryTidyRunSchema = z
  .object({
    status: z
      .enum(['ran', 'busy', 'idle'])
      .describe(
        '`ran`: the tidy-up finished. `busy`: one is running, so nothing was started. `idle`: none is running and none finished lately; only a read answers this.',
      ),
    moved_to_earlier: z.number().int().nonnegative().describe('Lines that had ended and were moved to Earlier.'),
    notes_asked: z.number().int().nonnegative().describe('Missed notes the model was asked about.'),
    notes_sorted: z
      .number()
      .int()
      .nonnegative()
      .describe('Missed notes whose answer was understood: sorted onto pages, or only noted in trial mode.'),
    pairs_listed: z.number().int().nonnegative().describe('Pairs of lines newly listed as disagreeing.'),
    sorting: PageSortModeSchema.describe(
      'The sorting choice the run followed; with `off` it only moved ended lines. `off` when nothing was started.',
    ),
    model_missing: z
      .boolean()
      .describe('True when sorting was not off but no model was found, so the steps that ask a model were skipped.'),
    unsorted_reasons: z
      .array(SortStopCauseSchema)
      .describe('Why notes were left unsorted in this run, each different cause once. Empty when none were.'),
  })
  .openapi('MemoryTidyRun');

export const RunMemoryNightlyResponseSchema = z
  .object({ data: MemoryTidyRunSchema })
  .openapi('RunMemoryNightlyResponse');

export const GetMemoryNightlyResponseSchema = z
  .object({ data: MemoryNightlySchema })
  .openapi('GetMemoryNightlyResponse');

export type MemoryNightly = z.infer<typeof MemoryNightlySchema>;
export type MemoryTidyRun = z.infer<typeof MemoryTidyRunSchema>;
export type UpdateMemoryNightlyRequest = z.infer<typeof UpdateMemoryNightlyRequestSchema>;
