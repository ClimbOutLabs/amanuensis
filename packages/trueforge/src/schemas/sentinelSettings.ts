import { z } from '@hono/zod-openapi';
import { TIER2_ACTION_KINDS } from '@truefoundry/trueforge-core/core';

const Tier2AutoAllowSchema = z
  .array(z.enum(TIER2_ACTION_KINDS))
  .describe('Tier 2 action kinds that run without asking. Kinds not listed ask for approval.');

export const SentinelUserSettingsSchema = z
  .object({
    offline_mode: z.boolean().describe('While on, actions that reach outside this machine are denied automatically.'),
    tier2_auto_allow: Tier2AutoAllowSchema,
    search_without_asking: z
      .boolean()
      .describe('While on, your designated search provider runs web searches without asking. Off asks for each one.'),
    maps_without_asking: z
      .boolean()
      .describe('While on, map requests run without asking unless private data was read in this chat.'),
    sandbox_without_asking: z
      .boolean()
      .describe(
        'While on, code, commands and workspace files in the sandbox run without asking. Off asks for each one.',
      ),
  })
  .openapi('SentinelUserSettings');

export const UpdateSentinelUserSettingsRequestSchema = z
  .object({
    offline_mode: z.boolean().optional().describe('New offline mode value; omitted keeps the current value.'),
    tier2_auto_allow: Tier2AutoAllowSchema.optional().describe(
      'Replaces the relaxed Tier 2 kinds; omitted keeps the current set.',
    ),
    search_without_asking: z.boolean().optional().describe('New search setting; omitted keeps the current value.'),
    maps_without_asking: z.boolean().optional().describe('New maps setting; omitted keeps the current value.'),
    sandbox_without_asking: z.boolean().optional().describe('New sandbox setting; omitted keeps the current value.'),
  })
  .openapi('UpdateSentinelUserSettingsRequest');

export const GetSentinelUserSettingsResponseSchema = z
  .object({ data: SentinelUserSettingsSchema })
  .openapi('GetSentinelUserSettingsResponse');

export type SentinelUserSettings = z.infer<typeof SentinelUserSettingsSchema>;
export type UpdateSentinelUserSettingsRequest = z.infer<typeof UpdateSentinelUserSettingsRequestSchema>;
