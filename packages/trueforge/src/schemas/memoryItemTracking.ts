import { z } from '@hono/zod-openapi';

/**
 * The item-tracking setting: the stored value (`enabled`: persisted override when
 * set, else the default, which is on).
 */
export const MemoryItemTrackingSchema = z
  .object({
    enabled: z.boolean().describe('The stored setting: the persisted override when set, else the default, on.'),
    overridden: z.boolean().describe('Whether a persisted override is currently stored.'),
    default_enabled: z.boolean().describe('The default used when no override is stored: on.'),
  })
  .openapi('MemoryItemTracking');

export const UpdateMemoryItemTrackingRequestSchema = z
  .object({
    enabled: z
      .boolean()
      .nullable()
      .describe('Persisted override: `true`/`false`. `null` clears the override back to the default.'),
  })
  .openapi('UpdateMemoryItemTrackingRequest', { example: { enabled: true } });

export const GetMemoryItemTrackingResponseSchema = z
  .object({
    data: MemoryItemTrackingSchema,
  })
  .openapi('GetMemoryItemTrackingResponse');

export type MemoryItemTracking = z.infer<typeof MemoryItemTrackingSchema>;
export type UpdateMemoryItemTrackingRequest = z.infer<typeof UpdateMemoryItemTrackingRequestSchema>;
