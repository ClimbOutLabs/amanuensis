/**
 * Wire schemas for the host-enforced memory recall passthrough event (`aman.memory.recall`).
 *
 * `injected_block` is byte-for-byte what {@link HindsightMemoryProcessor.processPreLLMEphemeral}
 * inserted ahead of the model call (or `null` when nothing was injected), so that the UI can
 * render this event and every datum the model received stays user-visible (SPEC.md invariant I5).
 *
 * These schemas live here, rather than in runtime/memory where the event is produced, so
 * schemas/events.ts and schemas/turn.ts can import them without reaching into runtime/memory,
 * and so they carry `.openapi()` names for OpenAPI document / SDK generation. `runtime/memory/
 * memoryEvents.ts` re-exports this module's schemas and types for its existing callers and
 * keeps the harness's passthrough event registry registration.
 */
import { z } from '@hono/zod-openapi';
import { EventIdSchema } from '@truefoundry/trueforge-core/core/events/schema';

export const MemoryRecallStatsSchema = z
  .object({
    items: z.number().int().nonnegative().describe('Recalled items included in the injected block.'),
    entities: z.number().int().nonnegative().describe('Entity summaries included in the injected block.'),
    dropped_over_budget: z
      .number()
      .int()
      .nonnegative()
      .describe('Recalled items dropped by the client-side token re-clamp.'),
    dropped_below_threshold: z
      .number()
      .int()
      .nonnegative()
      .describe('Recalled items and entity summaries dropped by the relevance gate (score below recall_min_score).'),
    estimated_tokens: z.number().int().nonnegative().describe('Estimated tokens of the included recalled items.'),
    recall_ms: z.number().int().nonnegative().describe('Wall-clock time spent on the recall call.'),
    outcome: z
      .enum(['ok', 'empty', 'timeout', 'error', 'skipped'])
      .describe(
        'ok: recall returned memory. empty: recall found none. timeout/error: recall failed; the turn ' +
          'proceeded anyway. skipped: recall was skipped (e.g., user disabled memory for this session, or for ' +
          'sandbox sessions). The curated and reflect layers (see `layers`) can still put a block in front of ' +
          'the model when recall itself found nothing.',
      ),
    reason: z.string().optional().describe('Failure detail when outcome is timeout or error.'),
    budget_reason: z
      .enum(['normal', 'post_compaction'])
      .describe(
        'normal: the full configured recall budget applied. post_compaction: a host-written compaction ' +
          'summary was seen recently, so the token budget was halved and entity summaries were skipped for ' +
          'this turn.',
      ),
  })
  .openapi('MemoryRecallStats');

/**
 * The curated layer: the bank's profile and the mental models relevant to this turn's query,
 * fetched on every turn with the recall. Cheap reads with no model call behind them.
 */
export const MemoryCuratedStatsSchema = z
  .object({
    profile: z
      .boolean()
      .describe('True when a bank profile line is in the injected block, after screening and budget.'),
    mental_models: z
      .number()
      .int()
      .nonnegative()
      .describe('Mental models in the injected block, after screening and budget.'),
    candidates: z.number().int().nonnegative().describe('Mental models the bank returned before relevance selection.'),
    withheld: z.number().int().nonnegative().describe('Curated lines the recall screen kept out of the block.'),
    dropped: z.number().int().nonnegative().describe('Curated lines dropped by the token budget.'),
    outcome: z
      .enum(['ok', 'empty', 'withheld', 'dropped', 'disabled', 'timeout', 'error'])
      .describe(
        'ok: at least one curated line injected. empty: nothing relevant. withheld/dropped: lines were ' +
          'read but none survived the screen or the budget. disabled: layer off. timeout/error: the ' +
          'worse of the profile and mental-model reads failed; lines from the other read are still injected.',
      ),
    reason: z.string().optional().describe('Failure detail when outcome is timeout or error.'),
  })
  .openapi('MemoryRecallCurated');

/**
 * The reflect layer: the provider's synthesized answer over its mental models, observations and
 * raw facts. It spends model calls, so it runs only when the newest user message is shaped like a
 * request for a conclusion (see runtime/memory/memoryRouting.ts) and the layer is enabled.
 */
export const MemoryReflectStatsSchema = z
  .object({
    route: z.enum(['recall', 'reflect']).describe('The route the newest user message selected.'),
    matched: z.string().optional().describe('Source of the synthesis pattern that selected reflect.'),
    outcome: z
      .enum(['ok', 'empty', 'withheld', 'dropped', 'skipped', 'disabled', 'timeout', 'error'])
      .describe(
        'ok: reflection injected. empty: reflect returned no text. withheld: the recall screen kept it ' +
          'out. dropped: the token budget kept it out. skipped: route was recall. disabled: layer off. ' +
          'timeout/error: reflect failed; the turn proceeded with the other layers.',
      ),
    reflect_ms: z.number().int().nonnegative().describe('Wall-clock time spent on the reflect call.'),
    based_on: z.number().int().nonnegative().describe('Memories the provider reported the reflection drew on.'),
    reason: z.string().optional().describe('Failure detail when outcome is timeout or error.'),
  })
  .openapi('MemoryRecallReflect');

export const MemoryLayersStatsSchema = z
  .object({
    curated: MemoryCuratedStatsSchema,
    reflect: MemoryReflectStatsSchema,
  })
  .openapi('MemoryRecallLayers');

export const MemorySweepStatsSchema = z
  .object({
    verified: z.number().int().nonnegative().describe('Pending retains confirmed complete or vanished this turn.'),
    retried: z.number().int().nonnegative().describe('Pending retains resubmitted this turn.'),
    abandoned: z.number().int().nonnegative().describe('Pending retains dropped after exceeding the retry cap.'),
    pending: z.number().int().nonnegative().describe('Retains still pending after this turn’s sweep.'),
  })
  .openapi('MemoryRecallSweep');

/**
 * One recall-screen decision worth surfacing: an item or entity summary withheld from the injected
 * block, or a user-stated item flagged malicious that was injected anyway (never withheld) and only
 * annotated. The audit payload is id + score + reason + origin, never the screened text, so a
 * withheld datum's content is not re-leaked through the event that records withholding it.
 */
export const MemoryScreenRecordSchema = z
  .object({
    id: z
      .string()
      .describe(
        'Per-turn-unique, type-qualified record id: `item:#<index>` for a recalled item, ' +
          '`entity:#<index>` for an entity summary, `curated:#<index>` for a profile or mental-model ' +
          'line, `reflection:#0` for the reflect answer, where <index> is the datum position within ' +
          "this turn. Not the provider's item id; correlate to the datum by its position in this " +
          "turn's model-context snapshot.",
      ),
    score: z.number().describe('Classifier score for the item; 0 when the screen result was unknown.'),
    reason: z
      .enum(['flagged_malicious', 'fenced_untrusted_origin_on_unknown', 'flagged_but_user_origin'])
      .describe(
        'flagged_malicious: untrusted-origin item the screen flagged, withheld. ' +
          'fenced_untrusted_origin_on_unknown: untrusted-origin item withheld because the screen gave no verdict. ' +
          'flagged_but_user_origin: user-stated item the screen flagged but injected anyway, only annotated.',
      ),
    origin: z.string().describe("The item's recorded origin, or 'absent' when legacy metadata carried none."),
    withheld: z.boolean().describe('True when the item was kept out of the injected block this turn.'),
  })
  .openapi('MemoryScreenRecord');

/**
 * The recall screen's per-turn ground truth, present only when screening actually ran over at
 * least one recalled item. `withheld` is the count of items and entity summaries kept out of the
 * injected block; `records` holds one entry per screen decision worth surfacing (every withheld
 * item or entity, plus any user-stated item flagged-but-injected). Absent when the screen is
 * disabled, so a disabled screen leaves the event byte-for-byte as before.
 */
export const MemoryScreenStatsSchema = z
  .object({
    withheld: z.number().int().nonnegative().describe('Recalled items kept out of the injected block by the screen.'),
    records: z.array(MemoryScreenRecordSchema).describe('One entry per surfaced screen decision this turn.'),
  })
  .openapi('MemoryRecallScreen');

/** The event's discriminator, named so runtime consumers need not restate the literal. */
export const MEMORY_RECALL_EVENT_TYPE = 'aman.memory.recall';

export const MemoryRecallEventSchema = z
  .object({
    type: z.literal(MEMORY_RECALL_EVENT_TYPE),
    injected_block: z.string().nullable(),
    stats: MemoryRecallStatsSchema,
    sweep: MemorySweepStatsSchema,
    // Optional so a screen-disabled turn (and every event written before this field existed)
    // stays a valid event unchanged; present only when the recall screen ran this turn.
    screen: MemoryScreenStatsSchema.optional(),
    // Optional for the same reason: present only on turns that ran the layered recall.
    layers: MemoryLayersStatsSchema.optional(),
  })
  .openapi('MemoryRecallEvent');

/**
 * The event as the durable log stores and returns it: the bare event plus the row's id and
 * timestamp. It lives beside the bare event, rather than in schemas/events.ts with the list and
 * stream envelopes, so that db/completedTurnEvents.ts can validate an append against it without
 * a value import of those envelopes, which would pull the trueforge-core barrels.
 *
 * Rebuilt flat from the bare event's shape rather than `.extend()`ing it: extending a schema that
 * already carries an `.openapi()` name emits an allOf composition, and wire schemas here are flat.
 * The bare event stays the one owner of the fields; this spread adds only the durable columns.
 *
 * `EventIdSchema` comes from the module that declares it rather than the
 * `@truefoundry/trueforge-core/core` barrel, for the same reason.
 */
export const MemoryRecallPersistedEventSchema = z
  .object({
    ...MemoryRecallEventSchema.shape,
    id: EventIdSchema,
    created_at: z.string().describe('ISO 8601 event timestamp.'),
  })
  .openapi('MemoryRecallPersistedEvent');

export type MemoryRecallStats = z.infer<typeof MemoryRecallStatsSchema>;
export type MemorySweepStats = z.infer<typeof MemorySweepStatsSchema>;
export type MemoryScreenRecord = z.infer<typeof MemoryScreenRecordSchema>;
export type MemoryScreenStats = z.infer<typeof MemoryScreenStatsSchema>;
export type MemoryCuratedStats = z.infer<typeof MemoryCuratedStatsSchema>;
export type MemoryReflectStats = z.infer<typeof MemoryReflectStatsSchema>;
export type MemoryLayersStats = z.infer<typeof MemoryLayersStatsSchema>;
export type MemoryRecallEvent = z.infer<typeof MemoryRecallEventSchema>;
export type MemoryRecallPersistedEvent = z.infer<typeof MemoryRecallPersistedEventSchema>;
