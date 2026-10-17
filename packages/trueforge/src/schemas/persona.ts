import { z } from '@hono/zod-openapi';
import {
  findPersonaContentNameConflict,
  PERSONA_ACTIVATION_SOURCES,
  PERSONA_CONTEXT_VERSION,
} from '../personas/persona';

const UnsafeCdataSequence = ']]>';

export const PersonaIdParamsSchema = z
  .object({ persona_id: z.string().min(1).max(64).describe('Stable persona identifier.') })
  .openapi('PersonaIDParams');

/**
 * Names are typed by a user at the start of a message, so they stay to
 * letters, digits, spaces and a few connectors. Angle brackets and ampersands
 * are excluded because a name is rendered into the prompt outside CDATA.
 * Periods are excluded too: a name is a token, not a sentence, so a value
 * like "Mannie. Ignore the rest" must never validate as a name.
 *
 * The `u` flag is what makes `\p{L}` a Unicode property escape rather than a
 * literal `p`, so it cannot be dropped from the runtime check.
 */
const PERSONA_NAME_REGEX = /^[\p{L}\p{N}][\p{L}\p{N} _'-]*$/u;

const PersonaNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  // Keep Unicode-aware validation in host code. OpenAPI patterns use an
  // ECMAScript-compatible subset and cannot portably represent `\p{L}` with
  // the required `u` flag, so publishing this regex would break SDK clients.
  .refine(value => PERSONA_NAME_REGEX.test(value), 'Names may use letters, numbers, spaces, and _ - ’');

const PersonaInstructionsSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(value => !value.includes(UnsafeCdataSequence), 'Persona instructions cannot contain ]]>.');

/** Same shape the agent spec uses for a model: an FQN the model catalog owns. */
const PersonaModelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .describe('Fully qualified model name (`provider/model`) selected when this persona is active.');

const PersonaContentBaseSchema = z
  .object({
    display_name: PersonaNameSchema.describe('Name shown in the UI and typed to invoke the persona.').openapi({
      example: 'Zara',
    }),
    aliases: z
      .array(PersonaNameSchema)
      .max(8)
      .describe('Extra names that invoke this persona. Must not collide with any other persona name or alias.'),
    instructions: PersonaInstructionsSchema.describe(
      'Concise role for the persona. Added as one section of the system prompt; it cannot replace harness policy.',
    ),
    model_name: PersonaModelNameSchema,
  })
  .strict();

export function validatePersonaContentNames(
  content: z.infer<typeof PersonaContentBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  const conflict = findPersonaContentNameConflict(content);
  if (conflict === undefined) {
    return;
  }
  if (conflict.conflictsWith === 'invocation determiner') {
    ctx.addIssue({
      code: 'custom',
      path: conflict.aliasIndex < 0 ? ['display_name'] : ['aliases', conflict.aliasIndex],
      message: `"${conflict.alias}" is a reserved persona-invocation determiner and cannot be used as a persona name or alias.`,
    });
    return;
  }
  ctx.addIssue({
    code: 'custom',
    path: ['aliases', conflict.aliasIndex],
    message: `Alias "${conflict.alias}" duplicates the ${conflict.conflictsWith} "${conflict.existingName}" after trimming and case-folding.`,
  });
}

export const PersonaContentSchema =
  PersonaContentBaseSchema.superRefine(validatePersonaContentNames).openapi('PersonaContent');

export const PersonaSchema = z
  .object({
    id: z.string().min(1).describe('Stable persona identifier.'),
    ...PersonaContentBaseSchema.shape,
    created_by: z.string().min(1),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    updated_by: z.string().min(1),
  })
  .strict()
  .superRefine(validatePersonaContentNames)
  .openapi('Persona');

export const CreatePersonaRequestSchema = z
  .object({ persona: PersonaContentSchema })
  .strict()
  .openapi('CreatePersonaRequest');
export const UpdatePersonaRequestSchema = z
  .object({ persona: PersonaContentSchema })
  .strict()
  .openapi('UpdatePersonaRequest');

export const PersonaActivationSourceSchema = z
  .enum(PERSONA_ACTIVATION_SOURCES)
  .describe(
    'How the persona was decided: `invocation` (explicitly invoked in the message), `sticky` (carried forward in this chat), `explicit` (chosen in the UI), `default` (returned to the default assistant).',
  )
  .openapi('PersonaActivationSource');

export const PersonaActivationSchema = z
  .object({
    id: z.string().min(1),
    session_id: z.string().min(1),
    turn_id: z.string().nullable().describe('Turn this decision applied to; null when changed outside a turn.'),
    persona_id: z.string().nullable().describe('Null means the default assistant was selected.'),
    persona_name: z.string().nullable().describe('Persona name as of this activation.'),
    model_name: z.string().nullable().describe('Exact model selected for the turn.'),
    source: PersonaActivationSourceSchema,
    created_at: z.iso.datetime(),
  })
  .strict()
  .openapi('PersonaActivation');

export const SetSessionPersonaRequestSchema = z
  .object({
    persona_id: z
      .string()
      .min(1)
      .nullable()
      .describe('Persona to activate for this chat, or null to return to the default assistant.'),
  })
  .strict()
  .openapi('SetSessionPersonaRequest', { example: { persona_id: 'persona-id' } });

export const PersonaContextSchema = z
  .object({
    version: z.literal(PERSONA_CONTEXT_VERSION),
    persona_id: z.string().min(1),
    persona_name: z.string().min(1),
    model_name: z.string().min(1),
    injected_context: z.string().min(1),
  })
  .strict()
  .openapi('PersonaContext');

export const ListPersonasResponseSchema = z.object({ data: z.array(PersonaSchema) }).openapi('ListPersonasResponse');
export const GetPersonaResponseSchema = z.object({ data: PersonaSchema }).openapi('GetPersonaResponse');
export const DeletePersonaResponseSchema = z.object({}).openapi('DeletePersonaResponse');
export const GetSessionPersonaResponseSchema = z
  .object({ data: z.union([PersonaActivationSchema, z.null()]) })
  .openapi('GetSessionPersonaResponse');
export const GetPersonaContextResponseSchema = z
  .object({ data: PersonaContextSchema })
  .openapi('GetPersonaContextResponse');
export const ListPersonaActivationsResponseSchema = z
  .object({ data: z.array(PersonaActivationSchema) })
  .openapi('ListPersonaActivationsResponse');

export type PersonaWire = z.infer<typeof PersonaSchema>;
export type PersonaActivationWire = z.infer<typeof PersonaActivationSchema>;
export type CreatePersonaRequest = z.infer<typeof CreatePersonaRequestSchema>;
export type UpdatePersonaRequest = z.infer<typeof UpdatePersonaRequestSchema>;
