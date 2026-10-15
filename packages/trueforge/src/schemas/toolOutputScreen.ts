import { z } from '@hono/zod-openapi';

/**
 * The live tool-output screen's stored setting: the persisted override when set,
 * else the `TOOL_OUTPUT_SCREEN_ENABLED` env default. This is the stored setting,
 * not the effective runtime state — screening is effectively off when no screening
 * service is configured (`MEMORY_SCREEN_URL` unset), even when this says on.
 */
export const ToolOutputScreenSchema = z
  .object({
    enabled: z
      .boolean()
      .describe(
        'The stored setting: the persisted override when set, else the `TOOL_OUTPUT_SCREEN_ENABLED` env default. Not the effective runtime state — screening is effectively off when no screening service is configured (`MEMORY_SCREEN_URL` unset).',
      ),
    overridden: z.boolean().describe('Whether a persisted override is currently stored.'),
    default_enabled: z
      .boolean()
      .describe('The `TOOL_OUTPUT_SCREEN_ENABLED` env default used when no override is stored.'),
  })
  .openapi('ToolOutputScreen');

export const UpdateToolOutputScreenRequestSchema = z
  .object({
    enabled: z
      .boolean()
      .nullable()
      .describe('Persisted override: `true`/`false`. `null` clears the override back to the env default.'),
  })
  .openapi('UpdateToolOutputScreenRequest', { example: { enabled: true } });

export const GetToolOutputScreenResponseSchema = z
  .object({
    data: ToolOutputScreenSchema,
  })
  .openapi('GetToolOutputScreenResponse');

export type ToolOutputScreen = z.infer<typeof ToolOutputScreenSchema>;
export type UpdateToolOutputScreenRequest = z.infer<typeof UpdateToolOutputScreenRequestSchema>;
