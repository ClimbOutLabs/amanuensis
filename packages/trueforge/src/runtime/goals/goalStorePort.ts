/**
 * The store contract the goal service runs on, in the shape of spec section 10.
 *
 * The canonical store (db/goalStore.ts, SQLite and Postgres) is scoped by the
 * owner's tenant and person together, and keeps a few service-owned details
 * inside its policy documents. The adapter in goalStoreAdapter.ts bridges that
 * store to this port, so the service depends only on this file and the store
 * can be swapped without the service, API, or tools changing. Records use the
 * repository's snake_case wire convention.
 */
import type { AgentSpec, CreatedBySubject, TokenPagination } from '@truefoundry/trueforge-core/agent-session';

export type GoalLifecycle = 'draft' | 'active' | 'paused' | 'completed' | 'ended';

/** Step states from spec section 8. */
export type GoalStepStatus =
  | 'planned'
  | 'ready'
  | 'in_progress'
  | 'waiting_for_approval'
  | 'awaiting_verification'
  | 'verified'
  | 'owner_confirmed'
  | 'failed'
  | 'outcome_unknown';

export type GoalSourceKind = 'space' | 'document' | 'mail' | 'calendar' | 'web' | 'manual';

/** One source the owner picked for this goal. A cycle may read only these. */
export interface GoalSourceRef {
  source_kind: GoalSourceKind;
  /** The source's own identifier: a space id, a document path, a mailbox label. */
  source_ref: string;
  /** What the owner calls it, shown on the card and the goal page. */
  label: string;
}

export interface GoalExecutionPolicy {
  /** Routine checks per day. One is the default; more is an explicit card choice. */
  checks_per_day: number;
  cycle_minutes: number;
  model_call_limit: number;
  tool_call_limit: number;
  cycle_token_limit: number;
  daily_token_allowance: number;
}

export interface GoalNotificationPolicy {
  /** Updates arrive as one short digest rather than one message per event. */
  digest: boolean;
}

/** One skill in a pinned setup: the reference the owner reviewed, plus a digest of its stored content. */
export interface PinnedSkill {
  name: string;
  preload: boolean;
  digest: string;
}

/**
 * The agent setup an activation pinned, resolved from the saved agent at that moment.
 * Holds references and content the owner reviewed, never credentials: connector
 * entries name a configured server, and its sign-in stays in the connector store,
 * rechecked at use time.
 */
export interface PinnedAgentSetup {
  agent_id: string;
  agent_name: string;
  /** The saved agent's version stamp when the agent store carries one; null where it does not. */
  agent_version: string | null;
  /** The exact setup resolved at activation. A cycle runs with this, never with the agent's later edits. */
  spec: AgentSpec;
  /** Each skill in the setup, with a digest of the content the store held at activation. */
  skills: readonly PinnedSkill[];
  /** SHA-256 of the canonical setup this snapshot was taken from; a changed setup digests differently. */
  digest: string;
  pinned_at: string;
}

export interface GoalRecord {
  goal_id: string;
  tenant_id: string;
  created_by: CreatedBySubject;
  persona_id: string | null;
  title: string;
  outcome: string;
  success_criteria: readonly string[];
  target_at: string | null;
  /** True when the person gave the target a time of day. False reads the target as a date alone. */
  target_has_time: boolean;
  timezone: string;
  lifecycle: GoalLifecycle;
  revision: number;
  /** The saved agent this goal runs as, chosen before activation; activation pins its setup. */
  agent_id: string | null;
  selected_sources: readonly GoalSourceRef[];
  execution_policy: GoalExecutionPolicy;
  notification_policy: GoalNotificationPolicy;
  linked_space_id: string | null;
  pinned_agent_id: string | null;
  pinned_agent_version: string | null;
  pinned_setup: PinnedAgentSetup | null;
  next_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalStepRecord {
  step_id: string;
  goal_id: string;
  description: string;
  depends_on: readonly string[];
  status: GoalStepStatus;
  acceptance_criteria: string;
  /** Sources whose reading speaks to this step; a check links their evidence here. */
  source_refs: readonly string[];
  evidence_ids: readonly string[];
  action_id: string | null;
}

export interface GoalEvidenceRecord {
  evidence_id: string;
  goal_id: string;
  cycle_id: string | null;
  source_kind: GoalSourceKind;
  source_ref: string;
  /** The source's own revision stamp, or a hash of what was read when it has none. */
  source_revision: string;
  observed_at: string;
  claimed_event_at: string | null;
  /** How the read content was taken in: read in full, or a bounded excerpt. */
  freshness: string;
  /** 'admitted' when the host accepted the read into the goal's record. */
  admission: string;
  extraction_method: string;
  /** The smallest useful excerpt, kept so the owner can see what the evidence says. */
  excerpt: string;
}

export type GoalCycleOutcome = 'completed' | 'nothing_changed' | 'needs_decision' | 'budget_exhausted' | 'failed';

export interface GoalCycleRecord {
  cycle_id: string;
  goal_id: string;
  input_revision: number;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  outcome: GoalCycleOutcome | null;
  outcome_detail: string | null;
  /** The session the cycle ran in, when one was dispatched. */
  session_id: string | null;
  next_check_at: string | null;
}

export interface GoalActionRecord {
  action_id: string;
  goal_id: string;
  cycle_id: string | null;
  expected_revision: number;
  tool_call_ref: string | null;
  approval_ref: string | null;
  execution_state: string;
  receipt_ref: string | null;
  created_at: string;
}

export interface GoalEventRecord {
  event_id: string;
  goal_id: string;
  sequence: number;
  event_type: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** A revision-checked write lost the race: the goal changed since the caller read it. */
export class GoalRevisionConflictError extends Error {
  readonly goal_id: string;
  readonly expected_revision: number;
  readonly actual_revision: number;

  constructor(input: { goal_id: string; expected_revision: number; actual_revision: number }, options?: ErrorOptions) {
    super(`Goal changed since it was read: ${input.goal_id}`, options);
    this.name = 'GoalRevisionConflictError';
    this.goal_id = input.goal_id;
    this.expected_revision = input.expected_revision;
    this.actual_revision = input.actual_revision;
  }
}

/** One step of a new goal's plan. Dependencies name plan positions; the adapter resolves them to the step ids it assigns. */
export interface CreateGoalStepInput {
  description: string;
  depends_on_indexes: readonly number[];
  status: GoalStepStatus;
  acceptance_criteria: string;
  source_refs: readonly string[];
}

export interface CreateGoalInput {
  tenant_id: string;
  created_by: CreatedBySubject;
  persona_id: string | null;
  title: string;
  outcome: string;
  success_criteria: readonly string[];
  target_at: string | null;
  target_has_time: boolean;
  timezone: string;
  agent_id: string | null;
  selected_sources: readonly GoalSourceRef[];
  execution_policy: GoalExecutionPolicy;
  notification_policy: GoalNotificationPolicy;
  linked_space_id: string | null;
  /** The plan the draft starts with; the adapter assigns each step its id. */
  steps: readonly CreateGoalStepInput[];
}

/** Fields an edit may change on a draft, or on an active goal's non-material details. */
export interface GoalPatch {
  title?: string;
  outcome?: string;
  success_criteria?: readonly string[];
  target_at?: string | null;
  target_has_time?: boolean;
  timezone?: string;
  /** The saved agent this goal runs as; activation pins its setup. */
  agent_id?: string | null;
  selected_sources?: readonly GoalSourceRef[];
  execution_policy?: GoalExecutionPolicy;
  notification_policy?: GoalNotificationPolicy;
  linked_space_id?: string | null;
  next_check_at?: string | null;
}

export interface UpdateGoalInput {
  tenant_id: string;
  /** The goal's owner, as the subject id the canonical store scopes rows by. */
  created_by: string;
  goal_id: string;
  expected_revision: number;
  lifecycle?: GoalLifecycle;
  patch?: GoalPatch;
  pinned_setup?: PinnedAgentSetup | null;
}

export interface IGoalStore<TTransaction = never> {
  createGoal(input: CreateGoalInput, transaction?: TTransaction): Promise<GoalRecord>;
  getGoal(
    input: { tenant_id: string; created_by: string; goal_id: string },
    transaction?: TTransaction,
  ): Promise<GoalRecord | undefined>;
  listGoals(
    input: {
      tenant_id: string;
      created_by: string;
      lifecycle?: GoalLifecycle;
      limit: number | undefined;
      page_token: string | undefined;
    },
    transaction?: TTransaction,
  ): Promise<{ data: GoalRecord[]; pagination: TokenPagination }>;
  /** Revision-checked update. Throws GoalRevisionConflictError when the goal moved on. */
  updateGoal(input: UpdateGoalInput, transaction?: TTransaction): Promise<GoalRecord | undefined>;
  listSteps(
    input: { tenant_id: string; created_by: string; goal_id: string },
    transaction?: TTransaction,
  ): Promise<GoalStepRecord[]>;
  updateStep(
    input: {
      tenant_id: string;
      created_by: string;
      goal_id: string;
      step_id: string;
      status?: GoalStepStatus;
      evidence_ids?: readonly string[];
      action_id?: string | null;
    },
    transaction?: TTransaction,
  ): Promise<GoalStepRecord | undefined>;
  addEvidence(
    input: Omit<GoalEvidenceRecord, 'evidence_id'> & { tenant_id: string; created_by: string },
    transaction?: TTransaction,
  ): Promise<GoalEvidenceRecord>;
  /** Newest first, so the first row per source is its latest recorded state. */
  listEvidence(
    input: {
      tenant_id: string;
      created_by: string;
      goal_id: string;
      limit: number | undefined;
      page_token: string | undefined;
    },
    transaction?: TTransaction,
  ): Promise<{ data: GoalEvidenceRecord[]; pagination: TokenPagination }>;
  startCycle(
    input: {
      tenant_id: string;
      created_by: string;
      goal_id: string;
      input_revision: number;
      trigger: string;
      started_at: string;
    },
    transaction?: TTransaction,
  ): Promise<GoalCycleRecord>;
  finishCycle(
    input: {
      tenant_id: string;
      created_by: string;
      goal_id: string;
      cycle_id: string;
      finished_at: string;
      outcome: GoalCycleOutcome;
      outcome_detail: string | null;
      session_id: string | null;
      next_check_at: string | null;
    },
    transaction?: TTransaction,
  ): Promise<GoalCycleRecord | undefined>;
  /** Actions still waiting for the owner's decision, oldest first. */
  listWaitingActions(
    input: {
      tenant_id: string;
      created_by: string;
      goal_id: string;
      limit: number | undefined;
      page_token: string | undefined;
    },
    transaction?: TTransaction,
  ): Promise<{ data: GoalActionRecord[]; pagination: TokenPagination }>;
  /** Appends one event; the store assigns its sequence within the goal. */
  appendEvent(
    input: {
      tenant_id: string;
      created_by: string;
      goal_id: string;
      event_type: string;
      actor: string;
      payload: Record<string, unknown>;
      created_at: string;
    },
    transaction?: TTransaction,
  ): Promise<GoalEventRecord>;
  /** In the order they happened: sequence ascending. */
  listEvents(
    input: {
      tenant_id: string;
      created_by: string;
      goal_id: string;
      limit: number | undefined;
      page_token: string | undefined;
    },
    transaction?: TTransaction,
  ): Promise<{ data: GoalEventRecord[]; pagination: TokenPagination }>;
}
