/**
 * Goals wire schemas: the goal record, its plan, evidence, events, and the
 * activation card shapes. Field names follow the repository's snake_case
 * convention and spec section 10.
 */
import { z } from '@hono/zod-openapi';
import {
  AgentSpecSchema,
  CreatedBySubjectSchema,
  TokenPaginationSchema,
} from '@truefoundry/trueforge-core/agent-session';

export const GoalIdParamsSchema = z
  .object({ goal_id: z.string().min(1).max(64).describe('Immutable goal identifier.') })
  .openapi('GoalIDParams');

export const GoalStepParamsSchema = z
  .object({
    goal_id: z.string().min(1).max(64).describe('Immutable goal identifier.'),
    step_id: z.string().min(1).max(64).describe('Immutable step identifier.'),
  })
  .openapi('GoalStepParams');

export const GoalLifecycleSchema = z.enum(['draft', 'active', 'paused', 'completed', 'ended']).openapi('GoalLifecycle');

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

export const GoalSourceKindSchema = z
  .enum(['space', 'document', 'mail', 'calendar', 'web', 'manual'])
  .openapi('GoalSourceKind');

export const GoalSourceRefSchema = z
  .object({
    source_kind: GoalSourceKindSchema,
    source_ref: z.string().min(1).max(512).describe("The source's own identifier, such as a space id."),
    label: z.string().min(1).max(200).describe('What the owner calls this source.'),
  })
  .strict()
  .openapi('GoalSourceRef');

export const GoalExecutionPolicySchema = z
  .object({
    checks_per_day: z.number().int().min(1).max(24).describe('Routine checks per day. One is the default.'),
    cycle_minutes: z.number().int().positive().max(240).describe('Longest time one check may work, in minutes.'),
    model_call_limit: z.number().int().positive().describe('Model calls one check may make at most.'),
    tool_call_limit: z.number().int().positive().describe('Tool calls one check may make at most.'),
    cycle_token_limit: z.number().int().positive().describe('Tokens one check may use at most.'),
    daily_token_allowance: z.number().int().positive().describe('Tokens this goal may use per day across all checks.'),
  })
  .strict()
  .openapi('GoalExecutionPolicy');

export const GoalNotificationPolicySchema = z
  .object({
    digest: z.boolean().describe('True when updates arrive as one short digest instead of one message per event.'),
  })
  .strict()
  .openapi('GoalNotificationPolicy');

export const PinnedSkillSchema = z
  .object({
    name: z.string().min(1),
    preload: z.boolean(),
    digest: z.string().min(1).describe('Digest of the skill content the store held at activation.'),
  })
  .strict()
  .openapi('PinnedSkill');

export const PinnedAgentSetupSchema = z
  .object({
    agent_id: z.string().min(1),
    agent_name: z.string().min(1),
    agent_version: z.string().nullable().describe("The saved agent's version stamp at activation, when it has one."),
    spec: AgentSpecSchema,
    skills: z.array(PinnedSkillSchema),
    digest: z.string().min(1).describe('Digest of the whole setup, used to spot a setup that changed after review.'),
    pinned_at: z.string().describe('ISO-8601 time the setup was pinned.'),
  })
  .strict()
  .openapi('PinnedAgentSetup');

export const GoalSchema = z
  .object({
    goal_id: z.string().min(1),
    created_by_subject: CreatedBySubjectSchema,
    persona_id: z.string().nullable(),
    title: z.string().min(1),
    outcome: z.string().min(1),
    success_criteria: z.array(z.string()),
    target_at: z.string().nullable(),
    target_has_time: z.boolean(),
    timezone: z.string().min(1),
    lifecycle: GoalLifecycleSchema,
    revision: z.number().int().nonnegative(),
    agent_id: z.string().nullable(),
    selected_sources: z.array(GoalSourceRefSchema),
    execution_policy: GoalExecutionPolicySchema,
    notification_policy: GoalNotificationPolicySchema,
    linked_space_id: z.string().nullable(),
    pinned_agent_id: z.string().nullable(),
    pinned_agent_version: z.string().nullable(),
    pinned_setup: PinnedAgentSetupSchema.nullable(),
    next_check_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict()
  .openapi('Goal');

export const GoalStepSchema = z
  .object({
    step_id: z.string().min(1),
    goal_id: z.string().min(1),
    description: z.string().min(1),
    depends_on: z.array(z.string()),
    status: GoalStepStatusSchema,
    acceptance_criteria: z.string(),
    source_refs: z.array(z.string()),
    evidence_ids: z.array(z.string()),
    action_id: z.string().nullable(),
  })
  .strict()
  .openapi('GoalStep');

export const GoalDetailSchema = z
  .object({
    goal: GoalSchema,
    steps: z.array(GoalStepSchema),
    next_step_id: z.string().nullable().describe('The step work turns to next, or null when none is ready.'),
  })
  .strict()
  .openapi('GoalDetail');

export const GetGoalResponseSchema = z.object({ data: GoalDetailSchema }).openapi('GetGoalResponse');

export const ListGoalsResponseSchema = z
  .object({ data: z.array(GoalSchema), pagination: TokenPaginationSchema })
  .openapi('ListGoalsResponse');

export const CreateGoalStepRequestSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    depends_on_indexes: z.array(z.number().int().nonnegative()).max(20).default([]),
    acceptance_criteria: z.string().trim().max(500).default(''),
    source_refs: z.array(z.string().min(1).max(512)).max(20).default([]),
  })
  .strict()
  .openapi('CreateGoalStepRequest');

export const CreateGoalRequestSchema = z
  .object({
    agent_id: z.string().min(1).max(64).nullable().default(null),
    title: z.string().trim().min(1).max(200),
    outcome: z.string().trim().min(1).max(2000),
    success_criteria: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    target_at: z.string().nullable().default(null),
    target_has_time: z.boolean().default(false),
    timezone: z.string().trim().min(1).max(100).default('UTC'),
    selected_sources: z.array(GoalSourceRefSchema).max(50).default([]),
    steps: z.array(CreateGoalStepRequestSchema).max(50).default([]),
    execution_policy: GoalExecutionPolicySchema.optional(),
    notification_policy: GoalNotificationPolicySchema.optional(),
    linked_space_id: z.string().min(1).max(64).nullable().default(null),
  })
  .strict()
  .openapi('CreateGoalRequest');

export const UpdateGoalRequestSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(200).optional(),
    outcome: z.string().trim().min(1).max(2000).optional(),
    success_criteria: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    target_at: z.string().nullable().optional(),
    target_has_time: z.boolean().optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    agent_id: z
      .string()
      .min(1)
      .max(64)
      .nullable()
      .optional()
      .describe('The saved agent this goal runs as. Changing it on an active goal needs a new activation card.'),
    selected_sources: z.array(GoalSourceRefSchema).max(50).optional(),
    execution_policy: GoalExecutionPolicySchema.optional(),
    notification_policy: GoalNotificationPolicySchema.optional(),
    linked_space_id: z.string().min(1).max(64).nullable().optional(),
  })
  .strict()
  .openapi('UpdateGoalRequest');

export const ActivateGoalRequestSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    setup_digest: z.string().min(1).describe('The digest of the setup shown on the card the owner reviewed.'),
  })
  .strict()
  .openapi('ActivateGoalRequest');

export const GoalRevisionRequestSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('GoalRevisionRequest');

export const ActivationPreviewSchema = z
  .object({
    goal: GoalSchema,
    steps: z.array(GoalStepSchema),
    setup: PinnedAgentSetupSchema,
  })
  .strict()
  .openapi('ActivationPreview');

export const GetActivationPreviewResponseSchema = z
  .object({ data: ActivationPreviewSchema })
  .openapi('GetActivationPreviewResponse');

/** Activation refused because the setup changed: the error plus the updated card to review. */
export const GoalSetupChangedResponseSchema = z
  .object({
    error: z.object({
      message: z.string(),
      code: z.literal('goal_setup_changed'),
    }),
    data: ActivationPreviewSchema,
  })
  .openapi('GoalSetupChangedResponse');

export const GoalEvidenceSchema = z
  .object({
    evidence_id: z.string().min(1),
    goal_id: z.string().min(1),
    cycle_id: z.string().nullable(),
    source_kind: GoalSourceKindSchema,
    source_ref: z.string().min(1),
    source_revision: z.string().min(1),
    observed_at: z.string(),
    claimed_event_at: z.string().nullable(),
    freshness: z.string(),
    admission: z.string(),
    extraction_method: z.string(),
    excerpt: z.string(),
  })
  .strict()
  .openapi('GoalEvidence');

export const ListGoalEvidenceResponseSchema = z
  .object({ data: z.array(GoalEvidenceSchema), pagination: TokenPaginationSchema })
  .openapi('ListGoalEvidenceResponse');

export const GoalEventSchema = z
  .object({
    event_id: z.string().min(1),
    goal_id: z.string().min(1),
    sequence: z.number().int().positive(),
    event_type: z.string().min(1),
    actor: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })
  .strict()
  .openapi('GoalEvent');

export const ListGoalEventsResponseSchema = z
  .object({ data: z.array(GoalEventSchema), pagination: TokenPaginationSchema })
  .openapi('ListGoalEventsResponse');

export const GoalApprovalSchema = z
  .object({
    action_id: z.string().min(1),
    goal_id: z.string().min(1),
    cycle_id: z.string().nullable(),
    expected_revision: z.number().int().nonnegative(),
    tool_call_ref: z.string().nullable(),
    approval_ref: z.string().nullable(),
    execution_state: z.string().min(1),
    receipt_ref: z.string().nullable(),
    created_at: z.string(),
  })
  .strict()
  .openapi('GoalApproval');

export const ListGoalApprovalsResponseSchema = z
  .object({ data: z.array(GoalApprovalSchema), pagination: TokenPaginationSchema })
  .openapi('ListGoalApprovalsResponse');

export const GoalCycleOutcomeSchema = z
  .enum(['completed', 'nothing_changed', 'needs_decision', 'budget_exhausted', 'failed'])
  .openapi('GoalCycleOutcome');

export const GoalCycleSchema = z
  .object({
    cycle_id: z.string().min(1),
    goal_id: z.string().min(1),
    input_revision: z.number().int().nonnegative(),
    trigger: z.string().min(1),
    started_at: z.string(),
    finished_at: z.string().nullable(),
    outcome: GoalCycleOutcomeSchema.nullable(),
    outcome_detail: z.string().nullable(),
    session_id: z.string().nullable(),
    next_check_at: z.string().nullable(),
  })
  .strict()
  .openapi('GoalCycle');

export const GoalCheckResultSchema = z
  .object({
    cycle: GoalCycleSchema,
    goal: GoalSchema,
    steps: z.array(GoalStepSchema),
    new_evidence: z.array(GoalEvidenceSchema),
    unread_sources: z.array(GoalSourceRefSchema),
    next_step_id: z.string().nullable(),
  })
  .strict()
  .openapi('GoalCheckResult');

export const GoalCheckResponseSchema = z.object({ data: GoalCheckResultSchema }).openapi('GoalCheckResponse');

export type Goal = z.infer<typeof GoalSchema>;
export type GoalStep = z.infer<typeof GoalStepSchema>;
export type GoalDetail = z.infer<typeof GoalDetailSchema>;
export type CreateGoalRequest = z.infer<typeof CreateGoalRequestSchema>;
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequestSchema>;
export type ActivateGoalRequest = z.infer<typeof ActivateGoalRequestSchema>;
export type GoalRevisionRequest = z.infer<typeof GoalRevisionRequestSchema>;
export type ActivationPreview = z.infer<typeof ActivationPreviewSchema>;
export type GoalEvidence = z.infer<typeof GoalEvidenceSchema>;
export type GoalEvent = z.infer<typeof GoalEventSchema>;
export type GoalApproval = z.infer<typeof GoalApprovalSchema>;
export type GoalCycle = z.infer<typeof GoalCycleSchema>;
export type GoalCheckResult = z.infer<typeof GoalCheckResultSchema>;
