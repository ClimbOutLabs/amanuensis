/**
 * Wire schemas for the host-side run_code provisioning passthrough event
 * (`aman.sandbox.provisioning`).
 *
 * The bare event schema is canonically owned by trueforge-core
 * (`core/sandbox/driver/provisionEvents.ts`) because the event is produced
 * there — `Sandbox.handleRunCode` emits it when the backend provisions (pulls)
 * the sandbox image. This module re-exports it and adds the persisted form
 * (flat, with the row's id and timestamp), so schemas/events.ts and
 * schemas/turn.ts can widen their wire unions without reaching into the
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
  PROVISIONING_EVENT_MAX_MESSAGES,
  PROVISIONING_EVENT_TYPE,
  ProvisioningEventSchema,
  type ProvisioningEvent,
} from '@truefoundry/trueforge-core/core/sandbox/driver/provisionEvents';

export { PROVISIONING_EVENT_MAX_MESSAGES, PROVISIONING_EVENT_TYPE, ProvisioningEventSchema };
export type { ProvisioningEvent };

/**
 * The event as the durable log stores and returns it: the bare event plus the
 * row's id and timestamp.
 */
export const ProvisioningPersistedEventSchema = z
  .object({
    ...ProvisioningEventSchema.shape,
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
  })
  .openapi('ProvisioningPersistedEvent');

export type ProvisioningPersistedEvent = z.infer<typeof ProvisioningPersistedEventSchema>;
