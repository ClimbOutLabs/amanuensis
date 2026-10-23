/**
 * Passthrough event emitted when a model step has to wait for another reply on the same model
 * to finish (see ModelRequestGate). It carries the one plain line the chat shows for the wait,
 * so every surface that renders the event uses the same words. The wait itself is not an error
 * and the step's silence deadlines have not started: they start when the request is sent.
 */
import { z } from '@hono/zod-openapi';

import { newEventId } from '../events/schema';

export const MODEL_WAITING_EVENT_TYPE = 'aman.model.waiting' as const;

/** The one line shown while a reply waits for the model to finish another reply. */
export const MODEL_WAITING_MESSAGE = 'Waiting for the model to finish another reply';

/** Payload of the `aman.model.waiting` passthrough event. */
export const ModelWaitingEventSchema = z
  .object({
    type: z.literal(MODEL_WAITING_EVENT_TYPE).describe('Emitted when a model step waits for another reply on the same model.'),
    message: z.string().describe('The plain line shown in the chat while the reply waits.'),
  })
  .openapi('ModelWaitingEvent');

export type ModelWaitingEvent = z.infer<typeof ModelWaitingEventSchema>;

/**
 * Registers `aman.model.waiting` in the harness's passthrough event registry, the same
 * in-package pattern as the sandbox provisioning event. This module deliberately does not
 * import RegisteredPassthroughEvent (see provisionEvents.ts for why).
 */
declare module '../events/PassthroughEvents' {
  interface AgentPassthroughEventSchemaMap {
    'aman.model.waiting': typeof ModelWaitingEventSchema;
  }
}

/** A fully-formed `aman.model.waiting` event: schema payload plus the passthrough envelope. */
export type ModelWaitingEventEnvelope = ModelWaitingEvent & {
  id: string;
  created_at: string;
};

/** Builds a fully-formed `aman.model.waiting` event (durable id + timestamp stamped). */
export function buildModelWaitingEvent(): ModelWaitingEventEnvelope {
  return {
    type: MODEL_WAITING_EVENT_TYPE,
    id: newEventId(),
    created_at: new Date().toISOString(),
    message: MODEL_WAITING_MESSAGE,
  };
}
