/**
 * Wire schemas for the model-waiting passthrough event (`aman.model.waiting`).
 *
 * The bare event schema is canonically owned by trueforge-core
 * (`core/llm/modelWaitingEvent.ts`) because the event is produced there: AgentThread emits it
 * when a step has to wait for another reply on the same model to finish. This module re-exports
 * it and adds the persisted form (flat, with the row's id and timestamp), so schemas/events.ts
 * and schemas/turn.ts can widen their wire unions without reaching into the runtime, and so the
 * persisted shape carries an `.openapi()` name for OpenAPI document / SDK generation.
 *
 * The persisted form is rebuilt flat from the bare event's shape rather than `.extend()`ing it:
 * extending a schema that already carries an `.openapi()` name emits an allOf composition, and
 * wire schemas here are flat.
 */
import { z } from '@hono/zod-openapi';
import { EventIdSchema } from '@truefoundry/trueforge-core/core/events/schema';
import {
  MODEL_WAITING_EVENT_TYPE,
  ModelWaitingEventSchema,
  type ModelWaitingEvent,
} from '@truefoundry/trueforge-core/core/llm/modelWaitingEvent';

export { MODEL_WAITING_EVENT_TYPE, ModelWaitingEventSchema };
export type { ModelWaitingEvent };

/**
 * The event as the durable log stores and returns it: the bare event plus the
 * row's id and timestamp.
 */
export const ModelWaitingPersistedEventSchema = z
  .object({
    ...ModelWaitingEventSchema.shape,
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
  })
  .openapi('ModelWaitingPersistedEvent');

export type ModelWaitingPersistedEvent = z.infer<typeof ModelWaitingPersistedEventSchema>;
