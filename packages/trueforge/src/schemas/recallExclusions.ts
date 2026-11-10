import { z } from '@hono/zod-openapi';

/**
 * One fact the person pulled out of a chat's memory recall. The exclusion lasts for that chat
 * only: recall in the chat skips the fact, and the memory itself is never changed or deleted.
 */
export const RecallExclusionSchema = z
  .object({
    session_id: z.string().describe('The chat the fact is pulled out of.'),
    fact_text: z.string().describe('The fact, in the plain words the recall showed for it.'),
  })
  .openapi('RecallExclusion');

/**
 * The longest fact text an exclusion can carry. A recalled fact is one line of the recall
 * block, whose whole budget is a few hundred tokens, so this sits far above any real fact
 * while keeping a stored exclusion bounded.
 */
export const RECALL_EXCLUSION_FACT_TEXT_MAX_LENGTH = 2000;

export const CreateRecallExclusionRequestSchema = z
  .object({
    fact_text: z
      .string()
      .min(1)
      .max(RECALL_EXCLUSION_FACT_TEXT_MAX_LENGTH)
      .describe('The fact to stop recalling in this chat, in the plain words the recall showed for it.'),
  })
  .strict()
  .openapi('CreateRecallExclusionRequest');

export const CreateRecallExclusionResponseSchema = z
  .object({ data: RecallExclusionSchema })
  .openapi('CreateRecallExclusionResponse');

export type RecallExclusion = z.infer<typeof RecallExclusionSchema>;
export type CreateRecallExclusionRequest = z.infer<typeof CreateRecallExclusionRequestSchema>;
