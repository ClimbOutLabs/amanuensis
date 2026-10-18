import { z } from '@hono/zod-openapi';

/** Whether the owner has put away the first-run checklist. */
export const FirstRunGuideSchema = z
  .object({
    dismissed: z.boolean().describe('True once the owner has dismissed the first-run checklist.'),
  })
  .openapi('FirstRunGuide', { example: { dismissed: true } });

export const UpdateFirstRunGuideRequestSchema = z
  .object({
    dismissed: z.boolean().describe('True to put the checklist away; false to show it again.'),
  })
  .strict()
  .openapi('UpdateFirstRunGuideRequest', { example: { dismissed: true } });

export const GetFirstRunGuideResponseSchema = z
  .object({ data: FirstRunGuideSchema })
  .openapi('GetFirstRunGuideResponse');

export type FirstRunGuide = z.infer<typeof FirstRunGuideSchema>;
export type UpdateFirstRunGuideRequest = z.infer<typeof UpdateFirstRunGuideRequestSchema>;
