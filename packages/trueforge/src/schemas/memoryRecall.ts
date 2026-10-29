import { z } from '@hono/zod-openapi';

/** The person-level switch for using saved memories in replies. `enabled` is null until someone sets it. */
export const MemoryRecallSchema = z
  .object({
    enabled: z
      .boolean()
      .nullable()
      .describe(
        'Whether replies use saved memories. `null` when not set, so each agent follows its own memory setting.',
      ),
  })
  .openapi('MemoryRecall');

export const UpdateMemoryRecallRequestSchema = z
  .object({
    enabled: z
      .boolean()
      .nullable()
      .describe('`true` or `false` sets the switch for every chat. `null` clears it back to each agent setting.'),
  })
  .openapi('UpdateMemoryRecallRequest', { example: { enabled: false } });

export const GetMemoryRecallResponseSchema = z
  .object({
    data: MemoryRecallSchema,
  })
  .openapi('GetMemoryRecallResponse');

export type MemoryRecall = z.infer<typeof MemoryRecallSchema>;
export type UpdateMemoryRecallRequest = z.infer<typeof UpdateMemoryRecallRequestSchema>;
