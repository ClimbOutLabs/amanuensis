/**
 * Wire schemas for the host-side skill-use passthrough event (`aman.skill.used`).
 *
 * The bare event schema is canonically owned by trueforge-core
 * (`core/sandbox/skills/skillEvents.ts`) because the event is produced there —
 * `Sandbox.handleExec` detects when the agent reads a mounted skill's SKILL.md
 * or executes with a skill directory as cwd. This module re-exports it and adds
 * the persisted form (flat, with the row's id and timestamp), so schemas/events.ts
 * and schemas/turn.ts can widen their wire unions without reaching into the
 * sandbox runtime, and so the persisted shape carries an `.openapi()` name for
 * OpenAPI document / SDK generation.
 *
 * The persisted form is rebuilt flat from the bare event's shape rather than
 * `.extend()`ing it: extending a schema that already carries an `.openapi()`
 * name emits an allOf composition, and wire schemas here are flat.
 */
import { z } from '@hono/zod-openapi';
import { EventIdSchema } from '@truefoundry/trueforge-core/core/events/schema';
import {
  SKILL_USED_EVENT_TYPE,
  SkillUsedEventSchema,
  type SkillUsedEvent,
  type SkillUsedKind,
} from '@truefoundry/trueforge-core/core/sandbox/skills/skillEvents';

export { SKILL_USED_EVENT_TYPE, SkillUsedEventSchema };
export type { SkillUsedEvent, SkillUsedKind };

/**
 * The event as the durable log stores and returns it: the bare event plus the
 * row's id and timestamp.
 */
export const SkillUsedPersistedEventSchema = z
  .object({
    ...SkillUsedEventSchema.shape,
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
  })
  .openapi('SkillUsedPersistedEvent');

export type SkillUsedPersistedEvent = z.infer<typeof SkillUsedPersistedEventSchema>;
