/**
 * Passthrough event emitted when run_code provisions (pulls) its sandbox
 * image.
 *
 * The driver already streams pull progress through `onProgress`; this event
 * carries the bounded result of that step to the UI/chat stream on the tool
 * response so the provisioning phase is visible after the fact, not silent.
 * The long provisioning bound stays scoped to sandbox/run_code — no other
 * tool can emit this event.
 */
import { z } from '@hono/zod-openapi';
import { newEventId } from '../../events/schema';

export const PROVISIONING_EVENT_TYPE = 'aman.sandbox.provisioning' as const;

/** Max driver progress messages carried on one provisioning event; the rest are counted, not dropped silently. */
export const PROVISIONING_EVENT_MAX_MESSAGES = 50;

/** Payload of the `aman.sandbox.provisioning` passthrough event. */
export const ProvisioningEventSchema = z
  .object({
    type: z.literal(PROVISIONING_EVENT_TYPE).describe('Emitted when run_code provisions (pulls) its sandbox image.'),
    succeeded: z.boolean().describe('Whether the provisioning step completed and the image verified.'),
    messages: z.array(z.string()).describe('Ordered driver progress messages, oldest first (capped).'),
    truncated_count: z
      .number()
      .describe('Progress messages dropped from `messages` by the cap; 0 when nothing was dropped.'),
  })
  .openapi('ProvisioningEvent');

export type ProvisioningEvent = z.infer<typeof ProvisioningEventSchema>;

/**
 * Registers `aman.sandbox.provisioning` in the harness's passthrough event registry. The
 * augmentation targets the exact module that declares
 * `AgentPassthroughEventSchemaMap` (same in-package pattern as the cross-package
 * registrations in trueforge's runtime/memory/memoryEvents.ts), so the event
 * type-checks everywhere trueforge-core sources are compiled — including the
 * trueforge package via the `trueforge-dev` export condition.
 *
 * Note: this module deliberately does not import `RegisteredPassthroughEvent`.
 * Referencing the registry union here would evaluate it while this module is
 * still being processed — before this augmentation has merged — and TypeScript
 * caches that stale evaluation. The concrete `ProvisioningEventEnvelope` below is
 * structurally identical to the registered member, so it stays assignable to
 * the union wherever the union is evaluated after the augmentation merges.
 */
declare module '../../events/PassthroughEvents' {
  interface AgentPassthroughEventSchemaMap {
    'aman.sandbox.provisioning': typeof ProvisioningEventSchema;
  }
}

/** A fully-formed `aman.sandbox.provisioning` event: schema payload plus the passthrough envelope. */
export type ProvisioningEventEnvelope = ProvisioningEvent & {
  id: string;
  created_at: string;
};

/** Builds a fully-formed `aman.sandbox.provisioning` event (durable id + timestamp stamped). */
export function buildProvisioningEvent(input: {
  succeeded: boolean;
  messages: readonly string[];
}): ProvisioningEventEnvelope {
  const truncated_count = Math.max(0, input.messages.length - PROVISIONING_EVENT_MAX_MESSAGES);
  return {
    type: PROVISIONING_EVENT_TYPE,
    id: newEventId(),
    created_at: new Date().toISOString(),
    succeeded: input.succeeded,
    messages: input.messages.slice(0, PROVISIONING_EVENT_MAX_MESSAGES),
    truncated_count,
  };
}
