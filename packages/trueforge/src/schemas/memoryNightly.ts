import { z } from '@hono/zod-openapi';

export const MemoryNightlySchema = z
  .object({
    enabled: z
      .boolean()
      .describe('The stored setting: the persisted override when set, else the `MEMORY_NIGHTLY_JOB` env default.'),
    overridden: z.boolean().describe('Whether a persisted override is currently stored.'),
    default_enabled: z.boolean().describe('The `MEMORY_NIGHTLY_JOB` env default used when no override is stored.'),
  })
  .openapi('MemoryNightly');

export const UpdateMemoryNightlyRequestSchema = z
  .object({
    enabled: z
      .boolean()
      .nullable()
      .describe('Persisted override: `true` or `false`. `null` clears the override back to the env default.'),
  })
  .openapi('UpdateMemoryNightlyRequest', { example: { enabled: true } });

export const GetMemoryNightlyResponseSchema = z
  .object({ data: MemoryNightlySchema })
  .openapi('GetMemoryNightlyResponse');

export type MemoryNightly = z.infer<typeof MemoryNightlySchema>;
export type UpdateMemoryNightlyRequest = z.infer<typeof UpdateMemoryNightlyRequestSchema>;
