import { z } from 'zod';

import { TIER2_ACTION_KINDS } from '@truefoundry/trueforge-core/core';

export const Tier2ActionKindSchema = z.enum(TIER2_ACTION_KINDS).openapi('Tier2ActionKind');

export const SentinelUserSettingsSchema = z
  .object({
    tier2_always_ask: z.array(Tier2ActionKindSchema),
    offline_mode: z.boolean(),
  })
  .openapi('SentinelUserSettings');

export const UpdateSentinelUserSettingsRequestSchema = z
  .object({
    tier2_always_ask: z.array(Tier2ActionKindSchema).optional(),
    offline_mode: z.boolean().optional(),
  })
  .openapi('UpdateSentinelUserSettingsRequest');
