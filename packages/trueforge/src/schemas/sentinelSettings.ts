import { z } from '@hono/zod-openapi';
import { TIER2_ACTION_KINDS } from '@truefoundry/trueforge-core/core';

const Tier2AutoAllowSchema = z
  .array(z.enum(TIER2_ACTION_KINDS))
  .describe('Tier 2 action kinds that run without asking. Kinds not listed ask for approval.');

export const SentinelUserSettingsSchema = z
  .object({
    offline_mode: z.boolean().describe('While on, actions that reach outside this machine are denied automatically.'),
    tier2_auto_allow: Tier2AutoAllowSchema,
  })
  .openapi('SentinelUserSettings');

export const UpdateSentinelUserSettingsRequestSchema = z
  .object({
    offline_mode: z.boolean().optional().describe('New offline mode value; omitted keeps the current value.'),
    tier2_auto_allow: Tier2AutoAllowSchema.optional().describe(
      'Replaces the relaxed Tier 2 kinds; omitted keeps the current set.',
    ),
  })
  .openapi('UpdateSentinelUserSettingsRequest');

export const GetSentinelUserSettingsResponseSchema = z
  .object({ data: SentinelUserSettingsSchema })
  .openapi('GetSentinelUserSettingsResponse');

export type SentinelUserSettings = z.infer<typeof SentinelUserSettingsSchema>;
export type UpdateSentinelUserSettingsRequest = z.infer<typeof UpdateSentinelUserSettingsRequestSchema>;
