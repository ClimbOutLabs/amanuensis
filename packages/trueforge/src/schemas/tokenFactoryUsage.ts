import { z } from '@hono/zod-openapi';

export const TokenFactoryModelUsageSchema = z
  .object({
    model_id: z.string().describe('Model id the provider was called with.'),
    display_name: z.string().describe('Readable model name.'),
    input_tokens: z.number().int().nonnegative().describe('Input tokens counted today.'),
    output_tokens: z.number().int().nonnegative().describe('Output tokens counted today.'),
    calls: z.number().int().nonnegative().describe('Model calls counted today.'),
    cost_usd: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Cost in USD at the configured price, or null when the model has no known price.'),
  })
  .openapi('TokenFactoryModelUsage');

export const TokenFactoryUsageSchema = z
  .object({
    usage_date: z.string().describe('UTC day these counters cover, as `YYYY-MM-DD`. They reset at midnight UTC.'),
    cap_tokens: z.number().int().positive().nullable().describe('Daily token cap, or null when there is none.'),
    used_tokens: z.number().int().nonnegative().describe('Input plus output tokens counted today.'),
    remaining_tokens: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Tokens left under the cap today, or null when there is no cap.'),
    cost_usd: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Cost in USD of all models today, or null when any model has no known price.'),
    models: z.array(TokenFactoryModelUsageSchema).describe('Per-model counters, most tokens first.'),
  })
  .openapi('TokenFactoryUsage');

export const GetTokenFactoryUsageResponseSchema = z
  .object({ data: TokenFactoryUsageSchema })
  .openapi('GetTokenFactoryUsageResponse');

export type TokenFactoryUsage = z.infer<typeof TokenFactoryUsageSchema>;
