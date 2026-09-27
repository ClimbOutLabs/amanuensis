import { z } from '@hono/zod-openapi';

/**
 * The recall screen's stored setting: the persisted override when set, else the
 * `MEMORY_SCREEN_ENABLED` env default. This is the stored setting, not the effective
 * runtime state — recall screening is effectively off when no screening service is
 * configured (`MEMORY_SCREEN_URL` unset), even when this says on.
 */
export const MemoryScreenSchema = z
  .object({
    enabled: z
      .boolean()
      .describe(
        'The stored setting: the persisted override when set, else the `MEMORY_SCREEN_ENABLED` env default. Not the effective runtime state — recall screening is effectively off when no screening service is configured (`MEMORY_SCREEN_URL` unset).',
      ),
    overridden: z.boolean().describe('Whether a persisted override is currently stored.'),
    default_enabled: z
      .boolean()
      .describe('The `MEMORY_SCREEN_ENABLED` env default used when no override is stored.'),
  })
  .openapi('MemoryScreen');

export const UpdateMemoryScreenRequestSchema = z
  .object({
    enabled: z
      .boolean()
      .nullable()
      .describe('Persisted override: `true`/`false`. `null` clears the override back to the env default.'),
  })
  .openapi('UpdateMemoryScreenRequest');

export const GetMemoryScreenResponseSchema = z
  .object({
    data: MemoryScreenSchema,
  })
  .openapi('GetMemoryScreenResponse');

export type MemoryScreen = z.infer<typeof MemoryScreenSchema>;
export type UpdateMemoryScreenRequest = z.infer<typeof UpdateMemoryScreenRequestSchema>;
