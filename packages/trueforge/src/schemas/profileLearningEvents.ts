/**
 * Wire schemas for the host-run learned-profile passthrough event (`aman.profile.learned`).
 *
 * The event is the audit trail of the autonomous distillation pass: `previous` is the learned
 * document the pass started from (or `null` on the first write), `current` is the complete
 * rewritten document it stored, and `revision` is the profile revision that write produced, so
 * the UI can show exactly what the host changed and when.
 *
 * These schemas live here, rather than in runtime/ where the event is produced, so
 * schemas/events.ts and schemas/turn.ts can import them without reaching into runtime/, and so
 * they carry `.openapi()` names for OpenAPI document / SDK generation. `runtime/
 * profileLearning.ts` re-exports this module's schemas and types for its callers and keeps the
 * harness's passthrough event registry registration.
 */
import { z } from '@hono/zod-openapi';
import { EventIdSchema } from '@truefoundry/trueforge-core/core/events/schema';

/** The event's discriminator, named so runtime consumers need not restate the literal. */
export const PROFILE_LEARNED_EVENT_TYPE = 'aman.profile.learned';

/**
 * Canonical field shape, shared by the bare event and the persisted wire form below.
 * A plain field map spread into two flat `z.object` calls, rather than
 * `.extend()`, so the OpenAPI document emits flat component schemas instead of allOf wrappers.
 */
export const PROFILE_LEARNED_EVENT_FIELDS = {
  type: z.literal(PROFILE_LEARNED_EVENT_TYPE),
  previous: z.string().nullable().describe('Learned document before this pass, or null on the first write.'),
  current: z.string().describe('Complete learned document this pass stored.'),
  revision: z.number().int().positive().describe('Personalization profile revision produced by this write.'),
};

export const ProfileLearnedEventSchema = z.object({ ...PROFILE_LEARNED_EVENT_FIELDS }).openapi('ProfileLearnedEvent');

/**
 * The event as the durable log stores and returns it: the shared field map plus the row's id and
 * timestamp. It lives beside the bare event, rather than in schemas/events.ts with the list and
 * stream envelopes, so that db/completedTurnEvents.ts can validate an append against it without
 * a value import of those envelopes, which would pull the trueforge-core barrels.
 *
 * `EventIdSchema` comes from the module that declares it rather than the
 * `@truefoundry/trueforge-core/core` barrel, for the same reason.
 */
export const ProfileLearnedPersistedEventSchema = z
  .object({
    ...PROFILE_LEARNED_EVENT_FIELDS,
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
  })
  .openapi('ProfileLearnedPersistedEvent');

export type ProfileLearnedEvent = z.infer<typeof ProfileLearnedEventSchema>;
export type ProfileLearnedPersistedEvent = z.infer<typeof ProfileLearnedPersistedEventSchema>;
