/**
 * Server event wire schemas: SSE streaming union + list-query envelopes.
 * Lifecycle / persisted event schemas live in agentSession.
 */
import { z } from '@hono/zod-openapi';
import {
  EventType,
  SessionEventSchema,
  TokenPaginationSchema,
  TurnCreatedEventSchema,
  TurnDoneEventSchema,
} from '@truefoundry/trueforge-core/agent-session';
import {
  ContextCompactionEventSchema,
  DocumentIngestionEventSchema,
  MCPAuthRequiredEventSchema,
  MCPInitializeEventSchema,
  ModelMessageDeltaEventSchema,
  ModelMessageEventSchema,
  SandboxCreatedEventSchema,
  ThreadCreatedEventSchema,
  ThreadDoneEventSchema,
  ToolApprovalRequiredEventSchema,
  ToolExecutionStartedEventSchema,
  ToolResponseEventSchema,
  ToolResponseEventV2Schema,
  ToolResponseRequiredEventSchema,
} from '@truefoundry/trueforge-core/core';
import { EVENTS_PAGE_LIMIT } from './common';
import { MemoryRecallPersistedEventSchema, type MemoryRecallPersistedEvent } from './memoryEvents';
import { ProfileLearnedPersistedEventSchema, type ProfileLearnedPersistedEvent } from './profileLearningEvents';
import { ProvisioningPersistedEventSchema, type ProvisioningPersistedEvent } from './provisionEvents';
import { SkillUsedPersistedEventSchema, type SkillUsedPersistedEvent } from './skillEvents';

/**
 * `SessionEventSchema` (agent-session, core) enumerates only built-in durable events and
 * deliberately excludes passthrough events. `aman.memory.recall`, `aman.profile.learned`,
 * `aman.skill.used`, and `aman.sandbox.provisioning` are passthrough events registered by
 * trueforge (see runtime/memory/memoryEvents.ts, schemas/memoryEvents.ts,
 * runtime/profileLearning.ts, schemas/profileLearningEvents.ts,
 * schemas/skillEvents.ts, schemas/provisionEvents.ts), so the actual persisted event stream
 * this route lists can include them, so this widens the wire schema to match what the store
 * can actually return, the same way any future passthrough event added here would.
 */
export const SessionEventWithPassthroughSchema = z
  .union([
    SessionEventSchema,
    MemoryRecallPersistedEventSchema,
    ProfileLearnedPersistedEventSchema,
    SkillUsedPersistedEventSchema,
    ProvisioningPersistedEventSchema,
  ])
  .openapi('SessionEvent');

/** A built-in member's `type`; `tool.response.v2` is itself a union whose variants share one type. */
function builtInEventType(option: (typeof SessionEventSchema.options)[number]) {
  return 'shape' in option ? option.shape.type.value : option.options[0].shape.type.value;
}

/** Every `type` the persisted union above can carry, derived from its members so filters cannot drift. */
export const SessionEventTypeSchema = z
  .enum([
    ...SessionEventSchema.options.map(builtInEventType),
    MemoryRecallPersistedEventSchema.shape.type.value,
    ProfileLearnedPersistedEventSchema.shape.type.value,
    SkillUsedPersistedEventSchema.shape.type.value,
    ProvisioningPersistedEventSchema.shape.type.value,
  ])
  .openapi('SessionEventType');

const SessionEventItemWithPassthroughSchema = z
  .object({
    turn_id: z.string().describe('Turn that emitted this event.'),
    event: SessionEventWithPassthroughSchema,
  })
  .openapi('SessionEventItem');

export type { TurnCreatedEvent } from '@truefoundry/trueforge-core/agent-session';
export { EventType };

/** Live SSE stream for session turns — content events, deltas and lifecycle. */
export const TurnStreamingEventSchema = z
  .discriminatedUnion('type', [
    ModelMessageEventSchema,
    ModelMessageDeltaEventSchema,
    ToolExecutionStartedEventSchema,
    ToolResponseEventV2Schema,
    ToolResponseEventSchema,
    ThreadCreatedEventSchema,
    ThreadDoneEventSchema,
    MCPAuthRequiredEventSchema,
    MCPInitializeEventSchema,
    SandboxCreatedEventSchema,
    ToolApprovalRequiredEventSchema,
    ToolResponseRequiredEventSchema,
    TurnCreatedEventSchema,
    TurnDoneEventSchema,
    // Passthrough events dual-write to the live stream as well as the persisted
    // log, so the streaming union must carry them too or SDK clients reject the
    // whole stream the moment one arrives.
    MemoryRecallPersistedEventSchema,
    ProfileLearnedPersistedEventSchema,
    SkillUsedPersistedEventSchema,
    ProvisioningPersistedEventSchema,
    // Context compaction can run mid-turn and writes to the live stream just like the
    // persisted log; omitting it here breaks SDK deserialization of the turn stream the
    // moment compaction fires (see AgentThread.ts / ContextCompaction.ts).
    ContextCompactionEventSchema,
    // Document-ingestion progress is likewise yielded live, one event per file, from the turn
    // loop's pre-model extraction step (see AgentThread.extractStagedDocuments); omitting it here
    // breaks SDK deserialization of the turn stream the moment an upload's extraction reports
    // progress.
    DocumentIngestionEventSchema,
  ])
  .openapi('TurnStreamingEvent');

/** Event ids are 26-character ULIDs; the bound only keeps an oversized cursor out of the query. */
export const MAX_EVENT_ID_LENGTH = 128;

export const ListSessionEventsRequestQuerySchema = z
  .object({
    page_token: z
      .string()
      .optional()
      .describe(
        'Pagination cursor from `pagination.next_page_token`. It retains the branch anchor turn and returns older events toward the session start.',
      ),
    last_turn_id: z
      .string()
      .optional()
      .describe(
        'Newest turn in the listing window (initial load only; ignored when `page_token` is set). Lists that turn and its ancestors, newest events first. Omit to use the session last turn.',
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(EVENTS_PAGE_LIMIT)
      .optional()
      .default(EVENTS_PAGE_LIMIT)
      .describe(`Page size. Defaults to ${String(EVENTS_PAGE_LIMIT)}, max ${String(EVENTS_PAGE_LIMIT)}.`),
    // A single repeated query key arrives as a string, several as an array.
    types: z.preprocess(
      value => (typeof value === 'string' ? [value] : value),
      z
        .array(SessionEventTypeSchema)
        .min(1)
        .max(SessionEventTypeSchema.options.length)
        .optional()
        .describe('Event types to include; at most 19 entries.'),
    ),
    after_event_id: z
      .string()
      .min(1)
      .max(MAX_EVENT_ID_LENGTH)
      .optional()
      .describe(
        'Only list events whose id sorts after this event id. Pass the newest event id already seen to fetch just the newer events.',
      ),
  })
  .openapi('ListSessionEventsRequestQuery');

export const ListSessionEventsResponseSchema = z
  .object({
    data: z.array(SessionEventItemWithPassthroughSchema),
    pagination: TokenPaginationSchema,
  })
  .openapi('ListSessionEventsResponse');

/**
 * Every passthrough event this host registers, in its persisted form.
 *
 * The harness's registry (trueforge-core `AgentPassthroughEventSchemaMap`) is ambient
 * declaration merging, so it is empty in any TypeScript program that does not include the
 * modules declaring it. This union names the same events from the schemas that own them, which
 * makes it usable wherever the exception to turn immutability has to be stated in types
 * (see db/completedTurnEvents.ts).
 */
export type PersistedPassthroughEvent =
  MemoryRecallPersistedEvent | ProfileLearnedPersistedEvent | SkillUsedPersistedEvent | ProvisioningPersistedEvent;
export type TurnStreamingEvent = z.infer<typeof TurnStreamingEventSchema>;
