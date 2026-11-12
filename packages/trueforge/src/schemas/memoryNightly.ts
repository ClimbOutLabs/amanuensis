import { z } from '@hono/zod-openapi';

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
  })
  .openapi('UpdateMemoryNightlyRequest', { example: { enabled: true, hour: 0 } });

export const MemoryTidyRunSchema = z
  .object({
    status: z
      .enum(['ran', 'busy'])
      .describe('`ran`: the tidy-up finished. `busy`: one was already running, so nothing was started.'),
    moved_to_earlier: z.number().int().nonnegative().describe('Lines that had ended and were moved to Earlier.'),
    notes_sorted: z.number().int().nonnegative().describe('Missed notes that were sorted onto pages.'),
    pairs_listed: z.number().int().nonnegative().describe('Pairs of lines newly listed as disagreeing.'),
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
