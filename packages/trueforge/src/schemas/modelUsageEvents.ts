/**
 * Wire schemas for the host-recorded model usage passthrough event (`aman.model.usage`).
 *
 * One event sums the calls one role made on one model during a turn, using the usage the provider
 * reported. The UI reads these to show which model did the work under each answer and what it cost.
 * Written after the turn completes (and again after its follow-up helper work), so a turn can carry
 * several events for the same role and model; readers add them up.
 *
 * Lives here, like the other passthrough event schemas, so schemas/events.ts and
 * db/completedTurnEvents.ts can import it without reaching into runtime/.
 */
import { z } from '@hono/zod-openapi';
import { EventIdSchema } from '@truefoundry/trueforge-core/core/events/schema';

/** The event's discriminator, named so runtime consumers need not restate the literal. */
export const MODEL_USAGE_EVENT_TYPE = 'aman.model.usage';

export const ModelUsageRoleSchema = z
  .enum(['chat', 'delegation', 'compaction', 'summarization', 'profile_learning', 'relevance_judge'])
  .describe(
    'Job the model did: chat answers, sub-agent work, compaction, turn summarization, profile learning, or the knowledge relevance check.',
  )
  .openapi('ModelUsageRole');

/**
 * The event as the durable log stores, streams and returns it: the usage fields plus the row's id
 * and timestamp.
 */
export const ModelUsagePersistedEventSchema = z
  .object({
    type: z.literal(MODEL_USAGE_EVENT_TYPE),
    role: ModelUsageRoleSchema,
    model_name: z.string().describe('Configured model name, as the model picker lists it.'),
    model_id: z.string().describe('Model id the provider was called with.'),
    display_name: z.string().describe('Readable model name.'),
    provider: z.string().describe('Provider type that served the calls, for example `tokenfactory`.'),
    calls: z.number().int().positive().describe('Model calls summed into this event.'),
    reported_calls: z
      .number()
      .int()
      .nonnegative()
      .describe('Calls whose usage the provider reported. Zero means usage was not reported.'),
    input_tokens: z.number().int().nonnegative().describe('Input tokens over the reported calls.'),
    output_tokens: z.number().int().nonnegative().describe('Output tokens over the reported calls.'),
    cost_usd: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Cost in USD over the reported calls, or null when no price is known or usage was not reported.'),
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
  })
  .openapi('ModelUsagePersistedEvent');

// Registers the event with the harness so the durable turn event log (and archive import) accepts it.
declare module '../../../trueforge-core/src/core/events/PassthroughEvents' {
  interface AgentPassthroughEventSchemaMap {
    'aman.model.usage': typeof ModelUsagePersistedEventSchema;
  }
}

export type ModelUsageRole = z.infer<typeof ModelUsageRoleSchema>;
export type ModelUsagePersistedEvent = z.infer<typeof ModelUsagePersistedEventSchema>;
