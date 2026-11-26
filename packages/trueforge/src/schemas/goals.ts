import { z } from '@hono/zod-openapi';

/**
 * Canonical goal records (OODA spec v2, section 10). The goal store persists
 * these shapes; the Goals service and API layers build on them.
 *
 * Fields the spec names as a stored JSON document (the two policies, the
 * activation snapshot, cycle budgets, action preconditions, event payloads)
 * use `GoalJsonDocument`: the store carries them unchanged and the layer that
 * owns their meaning validates the contents.
 */

/** Wire ISO-8601 instant. Always UTC with milliseconds, from `Date.prototype.toISOString()`. */
const IsoTimestamp = z.iso.datetime().openapi({ type: 'string', format: 'date-time' });

const NullableIsoTimestamp = z.iso
  .datetime()
  .nullable()
  .openapi({ type: ['string', 'null'], format: 'date-time' });

/** A stored JSON document whose inner shape belongs to a later layer. */
export const GoalJsonDocumentSchema = z.record(z.string(), z.unknown()).openapi('GoalJsonDocument');

/** Persistent lifecycle (spec section 8). Ended is final: no transition leaves it. */
export const GoalLifecycleSchema = z.enum(['draft', 'active', 'paused', 'completed', 'ended']).openapi('GoalLifecycle');

/**
 * Host-derived attention state for an active goal (spec section 8). Derived by
 * the service from lifecycle, cycles, and waiting decisions; never stored.
 */
export const GoalAttentionStateSchema = z
  .enum(['working', 'waiting_for_you', 'waiting_for_source', 'blocked', 'work_limit_reached', 'ready_to_finish'])
  .openapi('GoalAttentionState');

/** Plan step status (spec section 8). */
export const GoalStepStatusSchema = z
  .enum([
    'planned',
    'ready',
    'in_progress',
    'waiting_for_approval',
    'awaiting_verification',
    'verified',
    'owner_confirmed',
    'failed',
    'outcome_unknown',
  ])
  .openapi('GoalStepStatus');

export const GoalSchema = z
  .object({
    goal_id: z.string().min(1),
    tenant_id: z.string().min(1),
    created_by: z.string().min(1),
    persona_id: z.string().min(1),
    /** The saved agent whose setup activation pinned. Null while nothing is pinned. */
    pinned_agent_id: z.string().min(1).nullable(),
    /** Version of the pinned setup the owner confirmed. Null while nothing is pinned. */
    pinned_agent_version: z.string().min(1).nullable(),
    /**
     * Versioned activation snapshot of the resolved agent setup (model,
     * instructions, tools, connections, skill versions or digests), stored when
     * the agent store has no loadable immutable version. Never holds credentials.
     */
    pinned_agent_snapshot: GoalJsonDocumentSchema.nullable(),
    title: z.string().min(1),
    outcome: z.string().min(1),
    /** Observable success criteria, one statement each. */
    success_criteria: z.array(z.string()),
    target_at: NullableIsoTimestamp,
    /** True when the person gave the target a time of day. False reads the target as a date alone. */
    target_has_time: z.boolean(),
    timezone: z.string().min(1).nullable(),
    lifecycle: GoalLifecycleSchema,
    /** Store revision. Every committed change advances it by one. */
    revision: z.number().int().positive(),
    linked_space_id: z.string().min(1).nullable(),
    execution_policy: GoalJsonDocumentSchema,
    notification_policy: GoalJsonDocumentSchema,
    next_check_at: NullableIsoTimestamp,
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .strict()
  .openapi('Goal');

export const GoalPlanStepSchema = z
  .object({
    step_id: z.string().min(1),
    goal_id: z.string().min(1),
    description: z.string().min(1),
    /** Steps that must finish before this one, by step_id. */
    depends_on: z.array(z.string()),
    status: GoalStepStatusSchema,
    acceptance_criteria: z.array(z.string()),
    evidence_ids: z.array(z.string()),
    /** The decision/action prepared for this step, when one exists. */
    action_id: z.string().min(1).nullable(),
    revision: z.number().int().positive(),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .strict()
  .openapi('GoalPlanStep');

export const GoalEvidenceSchema = z
  .object({
    evidence_id: z.string().min(1),
    goal_id: z.string().min(1),
    source_kind: z.string().min(1),
    source_ref: z.string().min(1),
    /** The source's own revision when it offers one; otherwise null and `content_hash` carries the pin. */
    source_revision: z.string().min(1).nullable(),
    content_hash: z.string().min(1).nullable(),
    observed_at: IsoTimestamp,
    /** When the source says the event happened, when it says; may differ from `observed_at`. */
    claimed_event_at: NullableIsoTimestamp,
    freshness: z.string().min(1),
    admission: z.string().min(1),
    extraction_method: z.string().min(1),
  })
  .strict()
  .openapi('GoalEvidence');

/** The cycle's claim on the goal while it ran: fencing token, worker, and lease expiry. */
export const GoalCycleLeaseSchema = z
  .object({
    fencing_token: z.number().int().positive(),
    worker_id: z.string().min(1),
    expires_at: IsoTimestamp,
  })
  .strict()
  .openapi('GoalCycleLease');

/** Model and tool usage a cycle was charged, settled once per attempt. */
export const GoalCycleUsageSchema = z
  .object({
    model_calls: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('GoalCycleUsage');

export const GoalCycleSchema = z
  .object({
    cycle_id: z.string().min(1),
    goal_id: z.string().min(1),
    /** Goal revision the cycle started from. A commit at any other revision is stale. */
    input_revision: z.number().int().positive(),
    trigger_ids: z.array(z.string()),
    lease: GoalCycleLeaseSchema.nullable(),
    budgets: GoalJsonDocumentSchema,
    usage: GoalCycleUsageSchema,
    started_at: IsoTimestamp,
    finished_at: NullableIsoTimestamp,
    /**
     * How the cycle ended; null while it runs. The runner owns the value set.
     * The spec names `budget_exhausted` for a cycle stopped by a limit.
     */
    outcome: z.string().min(1).nullable(),
    outcome_detail: z.string().nullable(),
    next_check_at: NullableIsoTimestamp,
  })
  .strict()
  .openapi('GoalCycle');

export const GoalActionSchema = z
  .object({
    action_id: z.string().min(1),
    goal_id: z.string().min(1),
    /** The cycle that prepared the action, or null for one prepared outside a cycle. */
    cycle_id: z.string().min(1).nullable(),
    /** Goal revision the action was prepared against. Dispatch rechecks it. */
    expected_revision: z.number().int().positive(),
    preconditions: GoalJsonDocumentSchema,
    tool_call_ref: z.string().min(1).nullable(),
    approval_ref: z.string().min(1).nullable(),
    /** Where execution stands. The execution layer owns the value set. */
    execution_state: z.string().min(1),
    receipt_ref: z.string().min(1).nullable(),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .strict()
  .openapi('GoalAction');

export const GoalEventSchema = z
  .object({
    event_id: z.string().min(1),
    goal_id: z.string().min(1),
    /** Per-goal order, assigned by the store: 1 for the first event, advancing by one. */
    sequence: z.number().int().positive(),
    event_type: z.string().min(1),
    actor: z.string().min(1),
    payload: GoalJsonDocumentSchema,
    created_at: IsoTimestamp,
  })
  .strict()
  .openapi('GoalEvent');

export type GoalJsonDocument = z.infer<typeof GoalJsonDocumentSchema>;
export type GoalLifecycle = z.infer<typeof GoalLifecycleSchema>;
export type GoalAttentionState = z.infer<typeof GoalAttentionStateSchema>;
export type GoalStepStatus = z.infer<typeof GoalStepStatusSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type GoalPlanStep = z.infer<typeof GoalPlanStepSchema>;
export type GoalEvidence = z.infer<typeof GoalEvidenceSchema>;
export type GoalCycleLease = z.infer<typeof GoalCycleLeaseSchema>;
export type GoalCycleUsage = z.infer<typeof GoalCycleUsageSchema>;
export type GoalCycle = z.infer<typeof GoalCycleSchema>;
export type GoalAction = z.infer<typeof GoalActionSchema>;
export type GoalEvent = z.infer<typeof GoalEventSchema>;
