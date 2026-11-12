import { z } from '@hono/zod-openapi';

/**
 * The turn-summarization setting: the stored value (`enabled`: persisted override when
 * set, else the `MEMORY_SUMMARIZE` env default).
 */
export const MemorySummarizeSchema = z
  .object({
    enabled: z
      .boolean()
      .describe('The stored setting: the persisted override when set, else the `MEMORY_SUMMARIZE` env default.'),
    overridden: z.boolean().describe('Whether a persisted override is currently stored.'),
    default_enabled: z.boolean().describe('The `MEMORY_SUMMARIZE` env default used when no override is stored.'),
  })
  .openapi('MemorySummarize');

export const UpdateMemorySummarizeRequestSchema = z
  .object({
    enabled: z
      .boolean()
      .nullable()
      .describe('Persisted override: `true`/`false`. `null` clears the override back to the env default.'),
  })
  .openapi('UpdateMemorySummarizeRequest', { example: { enabled: true } });

export const GetMemorySummarizeResponseSchema = z
  .object({
    data: MemorySummarizeSchema,
  })
  .openapi('GetMemorySummarizeResponse');

export type MemorySummarize = z.infer<typeof MemorySummarizeSchema>;
export type UpdateMemorySummarizeRequest = z.infer<typeof UpdateMemorySummarizeRequestSchema>;
