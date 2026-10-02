import { z } from 'zod';

export const Tier2ActionKindSchema = z.enum(['file_write', 'shell', 'runner', 'branch']).openapi('Tier2ActionKind');

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
