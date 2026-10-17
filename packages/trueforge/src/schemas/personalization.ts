import { z } from '@hono/zod-openapi';
import { LEARNED_PROFILE_MAX_CHARACTERS, PERSONALIZATION_CONTEXT_VERSION } from '../personalization/profile';

const UnsafeCdataSequence = ']]>';

const PersonalizationTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(value => !value.includes(UnsafeCdataSequence), 'Personalization text cannot contain ]]>.');

const OptionalPersonalizationTextSchema = PersonalizationTextSchema.nullable();

/** Host-learned document: same shape rules as user-authored text, with its own larger bound. */
const LearnedProfileTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(LEARNED_PROFILE_MAX_CHARACTERS)
  .refine(value => !value.includes(UnsafeCdataSequence), 'Personalization text cannot contain ]]>.');

/** The learning switch. Optional on a request, always concrete on a stored profile. */
const LearningEnabledSchema = z
  .boolean()
  .describe('Whether the host may run the learned-profile distillation pass after completed turns.')
  .openapi({ example: false });

const PersonalizationProfileContentExample = {
  assistant_name: 'Aman',
  assistant_identity: 'A thoughtful local-first personal assistant.',
  voice_guidance: 'Warm, direct, and concise.',
  user_profile: 'Prefers local-first tools and plain English.',
  pinned_preferences: ['Use short bullet points.'],
  learned_profile: null,
  learning_enabled: false,
};

const PersonalizationProfileContentBaseSchema = z
  .object({
    assistant_name: OptionalPersonalizationTextSchema.openapi({ example: 'Aman' }),
    assistant_identity: OptionalPersonalizationTextSchema.openapi({
      example: 'A thoughtful local-first personal assistant.',
    }),
    voice_guidance: OptionalPersonalizationTextSchema.openapi({ example: 'Warm, direct, and concise.' }),
    user_profile: OptionalPersonalizationTextSchema.openapi({
      example: 'Prefers local-first tools and plain English.',
    }),
    pinned_preferences: z
      .array(PersonalizationTextSchema.max(280))
      .max(12)
      .openapi({ example: ['Use short bullet points.'] }),
    // Defaulted rather than required so pre-learned-profile clients that PUT without the key
    // stay valid; PUT replaces the complete profile, so an omitted key still reads as null.
    learned_profile: LearnedProfileTextSchema.nullable()
      .default(null)
      .describe('Host-learned profile document (markdown). Maintained by the learning pass; editable by the user.')
      .openapi({ example: null }),
    // Optional rather than defaulted, unlike learned_profile: the emptiness rule below has to
    // tell "learning explicitly off" from "a client that predates the toggle", and a default
    // erases that difference. The router reads an absent switch as off.
    learning_enabled: LearningEnabledSchema.optional(),
  })
  .strict();

export function validatePersonalizationContent(
  value: z.infer<typeof PersonalizationProfileContentBaseSchema>,
  ctx: z.RefinementCtx,
) {
  // The learned document is bounded separately (4,000 chars) and stays out of the user-authored
  // total, so host learning can never make a previously valid user profile fail validation.
  const totalLength =
    (value.assistant_name?.length ?? 0) +
    (value.assistant_identity?.length ?? 0) +
    (value.voice_guidance?.length ?? 0) +
    (value.user_profile?.length ?? 0) +
    value.pinned_preferences.reduce((sum, preference) => sum + preference.length, 0);
  if (totalLength > 5_500) {
    ctx.addIssue({ code: 'custom', message: 'Personalization content exceeds the 5,500 character limit.' });
  }
  if (new Set(value.pinned_preferences).size !== value.pinned_preferences.length) {
    ctx.addIssue({ code: 'custom', message: 'Pinned preferences must be distinct.' });
  }
  if (
    value.assistant_name === null &&
    value.assistant_identity === null &&
    value.voice_guidance === null &&
    value.user_profile === null &&
    value.pinned_preferences.length === 0 &&
    value.learned_profile === null &&
    // The switch is content in either position, not only when on. A profile holding nothing but
    // "learning off" is exactly where a user lands by trying the toggle and changing their mind,
    // and turning a switch back off must not be an error. Only a request that omits the switch
    // entirely carries no content at all, and that is what DELETE is for.
    value.learning_enabled === undefined
  ) {
    ctx.addIssue({ code: 'custom', message: 'Use DELETE to clear a personalization profile.' });
  }
}

export const PersonalizationProfileContentSchema = PersonalizationProfileContentBaseSchema.superRefine(
  validatePersonalizationContent,
).openapi('PersonalizationProfileContent', { example: PersonalizationProfileContentExample });

export const UpdatePersonalizationProfileRequestSchema = z
  .object({
    profile: PersonalizationProfileContentSchema,
  })
  .strict()
  .openapi('UpdatePersonalizationProfileRequest', {
    example: { profile: PersonalizationProfileContentExample },
  });

export const PersonalizationProfileSchema = z
  .object({
    ...PersonalizationProfileContentBaseSchema.shape,
    // A stored profile always has a concrete switch; only a request may leave it out.
    learning_enabled: LearningEnabledSchema,
    created_by: z.string().min(1),
    revision: z.number().int().positive(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .openapi({ example: 'a'.repeat(64) }),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    updated_by: z.string().min(1),
  })
  .strict()
  .superRefine(validatePersonalizationContent)
  .openapi('PersonalizationProfile');

export const PersonalizationContextSchema = z
  .object({
    version: z.literal(PERSONALIZATION_CONTEXT_VERSION),
    profile_revision: z.number().int().positive(),
    profile_digest: z.string().regex(/^[a-f0-9]{64}$/),
    injected_context: z.string().min(1),
  })
  .strict()
  .openapi('PersonalizationContext');

export const GetPersonalizationProfileResponseSchema = z
  .object({ data: PersonalizationProfileSchema.nullable() })
  .openapi('GetPersonalizationProfileResponse');
export const GetPersonalizationContextResponseSchema = z
  .object({ data: PersonalizationContextSchema.nullable() })
  .openapi('GetPersonalizationContextResponse');
export const DeletePersonalizationProfileResponseSchema = z.object({}).openapi('DeletePersonalizationProfileResponse');

export type UpdatePersonalizationProfileRequest = z.infer<typeof UpdatePersonalizationProfileRequestSchema>;
export type PersonalizationProfileWire = z.infer<typeof PersonalizationProfileSchema>;
