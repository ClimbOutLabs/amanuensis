import { decodePageToken, encodePageToken } from '@truefoundry/trueforge-core/agent-session/store/PageToken';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import {
  GoalActionSchema,
  GoalCycleLeaseSchema,
  GoalCycleSchema,
  GoalCycleUsageSchema,
  GoalEventSchema,
  GoalEvidenceSchema,
  GoalJsonDocumentSchema,
  GoalPlanStepSchema,
  GoalSchema,
  type Goal,
  type GoalAction,
  type GoalCycle,
  type GoalCycleLease,
  type GoalCycleUsage,
  type GoalEvent,
  type GoalEvidence,
  type GoalJsonDocument,
  type GoalLifecycle,
  type GoalPlanStep,
  type GoalStepStatus,
} from '../schemas/goals';
import { newId } from '../utils/id';
import type { PersonOwner } from './personOwner';

/**
 * One row of `goal`. Times are text on SQLite and timestamptz on Postgres.
 * JSON documents (policies, snapshot, criteria) are stored as serialized text
 * on both, so one implementation serves both databases.
 */
export interface GoalTable {
  goal_id: string;
  tenant_id: string;
  created_by: string;
  persona_id: string;
  pinned_agent_id: string | null;
  pinned_agent_version: string | null;
  pinned_agent_snapshot: string | null;
  title: string;
  outcome: string;
  success_criteria: string;
  target_at: string | Date | null;
  timezone: string | null;
  lifecycle: string;
  revision: number;
  linked_space_id: string | null;
  execution_policy: string;
  notification_policy: string;
  next_check_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface GoalStepTable {
  step_id: string;
  goal_id: string;
  description: string;
  depends_on: string;
  status: string;
  acceptance_criteria: string;
  evidence_ids: string;
  action_id: string | null;
  revision: number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface GoalEvidenceTable {
  evidence_id: string;
  goal_id: string;
  source_kind: string;
  source_ref: string;
  source_revision: string | null;
  content_hash: string | null;
  observed_at: string | Date;
  claimed_event_at: string | Date | null;
  freshness: string;
  admission: string;
  extraction_method: string;
}

export interface GoalEventTable {
  event_id: string;
  goal_id: string;
  sequence: number;
  event_type: string;
  actor: string;
  payload: string;
  created_at: string | Date;
}

export interface GoalCycleTable {
  cycle_id: string;
  goal_id: string;
  input_revision: number;
  trigger_ids: string;
  lease: string | null;
  budgets: string;
  usage: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  outcome: string | null;
  outcome_detail: string | null;
  next_check_at: string | Date | null;
}

export interface GoalActionTable {
  action_id: string;
  goal_id: string;
  cycle_id: string | null;
  expected_revision: number;
  preconditions: string;
  tool_call_ref: string | null;
  approval_ref: string | null;
  execution_state: string;
  receipt_ref: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** The one live claim on a goal. Never exported: a restored goal starts unclaimed. */
export interface GoalClaimTable {
  goal_id: string;
  tenant_id: string;
  created_by: string;
  fencing_token: number;
  worker_id: string;
  expires_at: string | Date;
  updated_at: string | Date;
}

/** A persisted wake-up for a goal, claimed by a worker and marked delivered once handed off. */
export interface GoalWakeupTable {
  wakeup_id: string;
  goal_id: string;
  tenant_id: string;
  created_by: string;
  event_key: string;
  kind: string;
  payload: string;
  available_at: string | Date;
  claimed_by: string | null;
  claim_expires_at: string | Date | null;
  delivered_at: string | Date | null;
  created_at: string | Date;
}

export interface GoalDatabase {
  goal: GoalTable;
  goal_step: GoalStepTable;
  goal_evidence: GoalEvidenceTable;
  goal_event: GoalEventTable;
  goal_cycle: GoalCycleTable;
  goal_action: GoalActionTable;
  goal_claim: GoalClaimTable;
  goal_wakeup: GoalWakeupTable;
}

/** The claim a worker holds on a goal. Commits name the fencing token; a taken-over claim fences the old one out. */
export interface GoalClaim {
  goal_id: string;
  fencing_token: number;
  worker_id: string;
  expires_at: string;
}

/** A persisted wake-up, as handed to the worker that claimed it. */
export interface GoalWakeup {
  wakeup_id: string;
  goal_id: string;
  tenant_id: string;
  created_by: string;
  event_key: string;
  kind: string;
  payload: GoalJsonDocument;
  available_at: string;
  created_at: string;
}

/** Everything an export carries for one owner: goal records and their children, in a stable order. */
export interface GoalExportBundle {
  goals: Goal[];
  steps: GoalPlanStep[];
  evidence: GoalEvidence[];
  events: GoalEvent[];
  cycles: GoalCycle[];
  actions: GoalAction[];
}

/** Lifecycle moves the store allows. Anything else is refused and changes nothing. */
export const GOAL_LIFECYCLE_TRANSITIONS: Readonly<Record<GoalLifecycle, readonly GoalLifecycle[]>> = {
  draft: ['active', 'ended'],
  active: ['paused', 'completed', 'ended'],
  paused: ['active', 'completed', 'ended'],
  completed: ['active'],
  ended: [],
};

export function canTransitionGoalLifecycle(from: GoalLifecycle, to: GoalLifecycle): boolean {
  return GOAL_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** The goal does not exist, or it belongs to someone else. Reads treat both the same. */
export class GoalNotFoundError extends Error {
  readonly goal_id: string;

  constructor(goal_id: string, options?: ErrorOptions) {
    super(`Goal not found: ${goal_id}`, options);
    this.name = 'GoalNotFoundError';
    this.goal_id = goal_id;
  }
}

/** A step, cycle, or action does not exist under the goal it was named with. */
export class GoalRecordNotFoundError extends Error {
  readonly record: 'step' | 'cycle' | 'action';
  readonly record_id: string;
  readonly goal_id: string;

  constructor(
    input: { record: 'step' | 'cycle' | 'action'; record_id: string; goal_id: string },
    options?: ErrorOptions,
  ) {
    super(`Goal ${input.record} not found: ${input.record_id} (goal ${input.goal_id})`, options);
    this.name = 'GoalRecordNotFoundError';
    this.record = input.record;
    this.record_id = input.record_id;
    this.goal_id = input.goal_id;
  }
}

/** The record changed since the caller read it. The write was refused and nothing changed. */
export class GoalRevisionConflictError extends Error {
  readonly record: 'goal' | 'step';
  readonly record_id: string;
  readonly expected_revision: number;
  readonly actual_revision: number;

  constructor(
    input: { record: 'goal' | 'step'; record_id: string; expected_revision: number; actual_revision: number },
    options?: ErrorOptions,
  ) {
    super(
      `Goal ${input.record} ${input.record_id} is at revision ${String(input.actual_revision)}, not ${String(input.expected_revision)}`,
      options,
    );
    this.name = 'GoalRevisionConflictError';
    this.record = input.record;
    this.record_id = input.record_id;
    this.expected_revision = input.expected_revision;
    this.actual_revision = input.actual_revision;
  }
}

/** The lifecycle move is not one the store allows. The write was refused and nothing changed. */
export class GoalLifecycleTransitionError extends Error {
  readonly goal_id: string;
  readonly from: GoalLifecycle;
  readonly to: GoalLifecycle;

  constructor(input: { goal_id: string; from: GoalLifecycle; to: GoalLifecycle }, options?: ErrorOptions) {
    super(`Goal ${input.goal_id} cannot move from ${input.from} to ${input.to}`, options);
    this.name = 'GoalLifecycleTransitionError';
    this.goal_id = input.goal_id;
    this.from = input.from;
    this.to = input.to;
  }
}

/** The caller's claim is not the goal's live claim, so its commit was refused. */
export class GoalClaimFencedError extends Error {
  readonly goal_id: string;
  readonly fencing_token: number;

  constructor(input: { goal_id: string; fencing_token: number }, options?: ErrorOptions) {
    super(`Goal ${input.goal_id} is not claimed by fencing token ${String(input.fencing_token)}`, options);
    this.name = 'GoalClaimFencedError';
    this.goal_id = input.goal_id;
    this.fencing_token = input.fencing_token;
  }
}

export interface CreateGoalInput extends PersonOwner {
  /** Caller-supplied id, used by data import so an imported goal keeps the id its records reference. */
  goal_id?: string | undefined;
  persona_id: string;
  pinned_agent_id: string | null;
  pinned_agent_version: string | null;
  pinned_agent_snapshot: GoalJsonDocument | null;
  title: string;
  outcome: string;
  success_criteria: readonly string[];
  target_at: string | null;
  timezone: string | null;
  lifecycle: GoalLifecycle;
  linked_space_id: string | null;
  execution_policy: GoalJsonDocument;
  notification_policy: GoalJsonDocument;
  next_check_at: string | null;
}

/** The goal fields an update may replace. Identity, owner, and persona never change. */
export interface GoalPatch {
  title?: string | undefined;
  outcome?: string | undefined;
  success_criteria?: readonly string[] | undefined;
  target_at?: string | null | undefined;
  timezone?: string | null | undefined;
  lifecycle?: GoalLifecycle | undefined;
  pinned_agent_id?: string | null | undefined;
  pinned_agent_version?: string | null | undefined;
  pinned_agent_snapshot?: GoalJsonDocument | null | undefined;
  linked_space_id?: string | null | undefined;
  execution_policy?: GoalJsonDocument | undefined;
  notification_policy?: GoalJsonDocument | undefined;
  next_check_at?: string | null | undefined;
}

export interface UpdateGoalInput extends PersonOwner {
  goal_id: string;
  expected_revision: number;
  patch: GoalPatch;
  /**
   * The caller's cycle claim. When given, the commit lands only while this
   * exact claim is the goal's live claim; a taken-over claim fences it out.
   */
  fencing_token?: number | undefined;
  /** A wake-up stored in the same transaction as the update, so a committed change never loses its wake-up. */
  wakeup?: EnqueueGoalWakeupInput | undefined;
}

export interface ListGoalsInput extends PersonOwner {
  lifecycle?: GoalLifecycle | undefined;
  limit: number;
  page_token?: string | undefined;
}

export interface AddGoalStepInput extends PersonOwner {
  goal_id: string;
  /** Caller-supplied id, used by data import. */
  step_id?: string | undefined;
  description: string;
  depends_on: readonly string[];
  status: GoalStepStatus;
  acceptance_criteria: readonly string[];
  evidence_ids: readonly string[];
  action_id: string | null;
}

export interface GoalStepPatch {
  description?: string | undefined;
  depends_on?: readonly string[] | undefined;
  status?: GoalStepStatus | undefined;
  acceptance_criteria?: readonly string[] | undefined;
  evidence_ids?: readonly string[] | undefined;
  action_id?: string | null | undefined;
}

export interface UpdateGoalStepInput extends PersonOwner {
  goal_id: string;
  step_id: string;
  expected_revision: number;
  patch: GoalStepPatch;
}

export interface AddGoalEvidenceInput extends PersonOwner {
  goal_id: string;
  /** Caller-supplied id, used by data import. */
  evidence_id?: string | undefined;
  source_kind: string;
  source_ref: string;
  source_revision: string | null;
  content_hash: string | null;
  observed_at: string;
  claimed_event_at: string | null;
  freshness: string;
  admission: string;
  extraction_method: string;
}

export interface ListGoalEvidenceInput extends PersonOwner {
  goal_id: string;
  limit: number;
  page_token?: string | undefined;
}

export interface AppendGoalEventInput extends PersonOwner {
  goal_id: string;
  event_type: string;
  actor: string;
  payload: GoalJsonDocument;
}

export interface ListGoalEventsInput extends PersonOwner {
  goal_id: string;
  limit: number;
  page_token?: string | undefined;
}

export interface RecordGoalCycleInput extends PersonOwner {
  goal_id: string;
  /** Caller-supplied id, used by data import. */
  cycle_id?: string | undefined;
  input_revision: number;
  trigger_ids: readonly string[];
  lease: GoalCycleLease | null;
  budgets: GoalJsonDocument;
  usage: GoalCycleUsage;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  outcome_detail: string | null;
  next_check_at: string | null;
}

export interface GoalCyclePatch {
  lease?: GoalCycleLease | null | undefined;
  budgets?: GoalJsonDocument | undefined;
  usage?: GoalCycleUsage | undefined;
  finished_at?: string | null | undefined;
  outcome?: string | null | undefined;
  outcome_detail?: string | null | undefined;
  next_check_at?: string | null | undefined;
}

export interface UpdateGoalCycleInput extends PersonOwner {
  goal_id: string;
  cycle_id: string;
  patch: GoalCyclePatch;
}

export interface ListGoalCyclesInput extends PersonOwner {
  goal_id: string;
  limit: number;
  page_token?: string | undefined;
}

export interface RecordGoalActionInput extends PersonOwner {
  goal_id: string;
  /** Caller-supplied id, used by data import. */
  action_id?: string | undefined;
  cycle_id: string | null;
  expected_revision: number;
  preconditions: GoalJsonDocument;
  tool_call_ref: string | null;
  approval_ref: string | null;
  execution_state: string;
  receipt_ref: string | null;
}

export interface GoalActionPatch {
  preconditions?: GoalJsonDocument | undefined;
  tool_call_ref?: string | null | undefined;
  approval_ref?: string | null | undefined;
  execution_state?: string | undefined;
  receipt_ref?: string | null | undefined;
}

export interface UpdateGoalActionInput extends PersonOwner {
  goal_id: string;
  action_id: string;
  patch: GoalActionPatch;
}

export interface ListGoalActionsInput extends PersonOwner {
  goal_id: string;
  limit: number;
  page_token?: string | undefined;
}

export interface ClaimGoalInput extends PersonOwner {
  goal_id: string;
  worker_id: string;
  ttl_ms: number;
}

export interface RenewGoalClaimInput extends PersonOwner {
  goal_id: string;
  fencing_token: number;
  ttl_ms: number;
}

export interface EnqueueGoalWakeupInput {
  event_key: string;
  kind: string;
  payload: GoalJsonDocument;
  /** When the wake-up becomes claimable. Defaults to now. */
  available_at?: string | undefined;
}

export interface ClaimGoalWakeupsInput {
  worker_id: string;
  limit: number;
  ttl_ms: number;
  /** Defaults to now. */
  now?: string | undefined;
}

export interface GoalPage<T> {
  data: T[];
  next_page_token: string | undefined;
}

export interface IGoalStore {
  /** Stores a new goal at revision 1. The record is validated before the write, so what is stored can always be read back. */
  createGoal(input: CreateGoalInput, transaction?: Kysely<GoalDatabase>): Promise<Goal>;
  /** One goal by id, or undefined when it is missing or belongs to someone else. */
  getGoal(input: PersonOwner & { goal_id: string }, transaction?: Kysely<GoalDatabase>): Promise<Goal | undefined>;
  /** The owner's goals, most recently updated first. */
  listGoals(input: ListGoalsInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPage<Goal>>;
  /**
   * Replaces the patched fields and advances the revision by one, in one
   * transaction with the optional wake-up. Refuses, changing nothing, when the
   * goal is gone, the expected revision is stale, the lifecycle move is not
   * allowed, or a named fencing token is not the live claim.
   */
  updateGoal(input: UpdateGoalInput, transaction?: Kysely<GoalDatabase>): Promise<Goal>;
  /** Deletes the goal and, by cascade, its steps, evidence, events, cycles, actions, claim, and wake-ups. Idempotent. */
  deleteGoal(input: PersonOwner & { goal_id: string }, transaction?: Kysely<GoalDatabase>): Promise<void>;

  /** Adds a plan step at revision 1 under a goal the owner owns. */
  addStep(input: AddGoalStepInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPlanStep>;
  /** The goal's plan steps, in the order they were added. Empty when the goal is missing or someone else's. */
  listSteps(input: PersonOwner & { goal_id: string }, transaction?: Kysely<GoalDatabase>): Promise<GoalPlanStep[]>;
  /** Replaces the patched step fields and advances the step revision. A stale expected revision is refused, changing nothing. */
  updateStep(input: UpdateGoalStepInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPlanStep>;

  /** Stores one evidence record under a goal the owner owns. */
  addEvidence(input: AddGoalEvidenceInput, transaction?: Kysely<GoalDatabase>): Promise<GoalEvidence>;
  /** The goal's evidence, newest observed first. */
  listEvidence(input: ListGoalEvidenceInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPage<GoalEvidence>>;

  /** Appends an event with the goal's next sequence. Concurrent appends retry so sequences stay gapless per goal. */
  appendEvent(input: AppendGoalEventInput, transaction?: Kysely<GoalDatabase>): Promise<GoalEvent>;
  /** The goal's events in sequence order. */
  listEvents(input: ListGoalEventsInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPage<GoalEvent>>;

  /** Stores one cycle record under a goal the owner owns. */
  recordCycle(input: RecordGoalCycleInput, transaction?: Kysely<GoalDatabase>): Promise<GoalCycle>;
  /** Replaces the patched cycle fields, for finishing a cycle and settling its usage. */
  updateCycle(input: UpdateGoalCycleInput, transaction?: Kysely<GoalDatabase>): Promise<GoalCycle>;
  /** The goal's cycles, most recently started first. */
  listCycles(input: ListGoalCyclesInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPage<GoalCycle>>;

  /** Stores one decision/action record under a goal the owner owns. */
  recordAction(input: RecordGoalActionInput, transaction?: Kysely<GoalDatabase>): Promise<GoalAction>;
  /** Replaces the patched action fields, for moving execution state and attaching refs as they arrive. */
  updateAction(input: UpdateGoalActionInput, transaction?: Kysely<GoalDatabase>): Promise<GoalAction>;
  /** The goal's actions, most recently recorded first. */
  listActions(input: ListGoalActionsInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPage<GoalAction>>;

  /**
   * Claims the goal for one worker. Resolves to the claim, or undefined while
   * another claim is live. An expired claim is taken over with a higher
   * fencing token, which fences the old holder's commits out.
   */
  claimGoal(input: ClaimGoalInput, transaction?: Kysely<GoalDatabase>): Promise<GoalClaim | undefined>;
  /** Extends the caller's live claim. Resolves to the claim, or undefined when the token is not the live claim. */
  renewClaim(input: RenewGoalClaimInput, transaction?: Kysely<GoalDatabase>): Promise<GoalClaim | undefined>;
  /**
   * Gives up the caller's claim by expiring it now. The row stays as the
   * fencing counter, so the next claim still gets a higher token and a stale
   * commit from the released claim stays fenced out. Resolves to whether a
   * live claim was released.
   */
  releaseClaim(
    input: PersonOwner & { goal_id: string; fencing_token: number },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<boolean>;
  /** The goal's current claim row, live or expired, or undefined when no claim was ever made. */
  getClaim(
    input: PersonOwner & { goal_id: string },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<GoalClaim | undefined>;

  /**
   * Persists a wake-up for a goal the owner owns. Idempotent on the event key:
   * the same key under the same goal returns the stored wake-up, not a second one.
   */
  enqueueWakeup(
    input: PersonOwner & { goal_id: string } & EnqueueGoalWakeupInput,
    transaction?: Kysely<GoalDatabase>,
  ): Promise<{ wakeup: GoalWakeup; created: boolean }>;
  /**
   * Claims due, undelivered wake-ups across goals for one worker. Internal
   * machinery: the claiming worker acts for whichever owner the wake-up names.
   */
  claimWakeups(input: ClaimGoalWakeupsInput, transaction?: Kysely<GoalDatabase>): Promise<GoalWakeup[]>;
  /** Marks a claimed wake-up delivered. Only the claiming worker can. Resolves to whether it was marked. */
  markWakeupDelivered(
    input: { wakeup_id: string; worker_id: string },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<boolean>;

  /** Everything an export carries for the owner. Claims and wake-ups are live machinery and never exported. */
  exportGoalData(input: PersonOwner, transaction?: Kysely<GoalDatabase>): Promise<GoalExportBundle>;
  /**
   * Adds an exported bundle under the owner, keeping the exported ids and
   * revisions. Records already present keep their rows. Resolves to how many
   * goals were added.
   */
  importGoalData(
    input: PersonOwner & { bundle: GoalExportBundle },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<{ goals_added: number }>;
}

const GoalListCursorSchema = z.object({ updated_at: z.string(), goal_id: z.string() });
const EvidenceCursorSchema = z.object({ observed_at: z.string(), evidence_id: z.string() });
const EventCursorSchema = z.object({ sequence: z.number() });
const CycleCursorSchema = z.object({ started_at: z.string(), cycle_id: z.string() });
const ActionCursorSchema = z.object({ created_at: z.string(), action_id: z.string() });

/** Rows per insert on import, well under the bound-variable limits of SQLite and Postgres. */
const IMPORT_BATCH_SIZE = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

const StringArraySchema = z.array(z.string());

function parseJsonDocument(raw: string): GoalJsonDocument {
  return GoalJsonDocumentSchema.parse(JSON.parse(raw));
}

function parseStringArray(raw: string): string[] {
  return StringArraySchema.parse(JSON.parse(raw));
}

function isUniqueViolationError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.message.includes('UNIQUE constraint failed') || error.message.includes('duplicate key')) {
      return true;
    }
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return error.code === '23505';
  }
  return false;
}

function toGoal(row: GoalTable): Goal {
  return GoalSchema.parse({
    goal_id: row.goal_id,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    persona_id: row.persona_id,
    pinned_agent_id: row.pinned_agent_id,
    pinned_agent_version: row.pinned_agent_version,
    pinned_agent_snapshot: row.pinned_agent_snapshot === null ? null : parseJsonDocument(row.pinned_agent_snapshot),
    title: row.title,
    outcome: row.outcome,
    success_criteria: parseStringArray(row.success_criteria),
    target_at: toIsoOrNull(row.target_at),
    timezone: row.timezone,
    lifecycle: row.lifecycle,
    revision: row.revision,
    linked_space_id: row.linked_space_id,
    execution_policy: parseJsonDocument(row.execution_policy),
    notification_policy: parseJsonDocument(row.notification_policy),
    next_check_at: toIsoOrNull(row.next_check_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

function toStep(row: GoalStepTable): GoalPlanStep {
  return GoalPlanStepSchema.parse({
    step_id: row.step_id,
    goal_id: row.goal_id,
    description: row.description,
    depends_on: parseStringArray(row.depends_on),
    status: row.status,
    acceptance_criteria: parseStringArray(row.acceptance_criteria),
    evidence_ids: parseStringArray(row.evidence_ids),
    action_id: row.action_id,
    revision: row.revision,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

function toEvidence(row: GoalEvidenceTable): GoalEvidence {
  return GoalEvidenceSchema.parse({
    evidence_id: row.evidence_id,
    goal_id: row.goal_id,
    source_kind: row.source_kind,
    source_ref: row.source_ref,
    source_revision: row.source_revision,
    content_hash: row.content_hash,
    observed_at: toIso(row.observed_at),
    claimed_event_at: toIsoOrNull(row.claimed_event_at),
    freshness: row.freshness,
    admission: row.admission,
    extraction_method: row.extraction_method,
  });
}

function toEvent(row: GoalEventTable): GoalEvent {
  return GoalEventSchema.parse({
    event_id: row.event_id,
    goal_id: row.goal_id,
    sequence: row.sequence,
    event_type: row.event_type,
    actor: row.actor,
    payload: parseJsonDocument(row.payload),
    created_at: toIso(row.created_at),
  });
}

function toCycle(row: GoalCycleTable): GoalCycle {
  return GoalCycleSchema.parse({
    cycle_id: row.cycle_id,
    goal_id: row.goal_id,
    input_revision: row.input_revision,
    trigger_ids: parseStringArray(row.trigger_ids),
    lease: row.lease === null ? null : GoalCycleLeaseSchema.parse(JSON.parse(row.lease)),
    budgets: parseJsonDocument(row.budgets),
    usage: GoalCycleUsageSchema.parse(JSON.parse(row.usage)),
    started_at: toIso(row.started_at),
    finished_at: toIsoOrNull(row.finished_at),
    outcome: row.outcome,
    outcome_detail: row.outcome_detail,
    next_check_at: toIsoOrNull(row.next_check_at),
  });
}

function toAction(row: GoalActionTable): GoalAction {
  return GoalActionSchema.parse({
    action_id: row.action_id,
    goal_id: row.goal_id,
    cycle_id: row.cycle_id,
    expected_revision: row.expected_revision,
    preconditions: parseJsonDocument(row.preconditions),
    tool_call_ref: row.tool_call_ref,
    approval_ref: row.approval_ref,
    execution_state: row.execution_state,
    receipt_ref: row.receipt_ref,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

function toClaim(row: GoalClaimTable): GoalClaim {
  return {
    goal_id: row.goal_id,
    fencing_token: row.fencing_token,
    worker_id: row.worker_id,
    expires_at: toIso(row.expires_at),
  };
}

function toWakeup(row: GoalWakeupTable): GoalWakeup {
  return {
    wakeup_id: row.wakeup_id,
    goal_id: row.goal_id,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    event_key: row.event_key,
    kind: row.kind,
    payload: parseJsonDocument(row.payload),
    available_at: toIso(row.available_at),
    created_at: toIso(row.created_at),
  };
}

function batches<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += IMPORT_BATCH_SIZE) {
    out.push(rows.slice(start, start + IMPORT_BATCH_SIZE));
  }
  return out;
}

/**
 * The one authoritative store for goals (spec section 10). Owner-scoped: no
 * read or write reaches another owner's rows, and a goal that is missing or
 * someone else's reads as missing. One implementation runs on both SQLite and
 * Postgres, the way the delivery store does.
 */
export class GoalStore implements IGoalStore {
  readonly #db: Kysely<GoalDatabase>;

  constructor(db: Kysely<GoalDatabase>) {
    this.#db = db;
  }

  async #goalRow(db: Kysely<GoalDatabase>, input: PersonOwner & { goal_id: string }): Promise<GoalTable | undefined> {
    return db
      .selectFrom('goal')
      .selectAll()
      .where('goal_id', '=', input.goal_id)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .executeTakeFirst();
  }

  async #requireGoal(db: Kysely<GoalDatabase>, input: PersonOwner & { goal_id: string }): Promise<GoalTable> {
    const row = await this.#goalRow(db, input);
    if (row === undefined) {
      throw new GoalNotFoundError(input.goal_id);
    }
    return row;
  }

  async createGoal(input: CreateGoalInput, transaction?: Kysely<GoalDatabase>): Promise<Goal> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    const goal = GoalSchema.parse({
      goal_id: input.goal_id ?? newId(),
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      persona_id: input.persona_id,
      pinned_agent_id: input.pinned_agent_id,
      pinned_agent_version: input.pinned_agent_version,
      pinned_agent_snapshot: input.pinned_agent_snapshot,
      title: input.title,
      outcome: input.outcome,
      success_criteria: [...input.success_criteria],
      target_at: input.target_at,
      timezone: input.timezone,
      lifecycle: input.lifecycle,
      revision: 1,
      linked_space_id: input.linked_space_id,
      execution_policy: input.execution_policy,
      notification_policy: input.notification_policy,
      next_check_at: input.next_check_at,
      created_at: timestamp,
      updated_at: timestamp,
    });
    await db
      .insertInto('goal')
      .values({
        goal_id: goal.goal_id,
        tenant_id: goal.tenant_id,
        created_by: goal.created_by,
        persona_id: goal.persona_id,
        pinned_agent_id: goal.pinned_agent_id,
        pinned_agent_version: goal.pinned_agent_version,
        pinned_agent_snapshot: goal.pinned_agent_snapshot === null ? null : JSON.stringify(goal.pinned_agent_snapshot),
        title: goal.title,
        outcome: goal.outcome,
        success_criteria: JSON.stringify(goal.success_criteria),
        target_at: goal.target_at,
        timezone: goal.timezone,
        lifecycle: goal.lifecycle,
        revision: goal.revision,
        linked_space_id: goal.linked_space_id,
        execution_policy: JSON.stringify(goal.execution_policy),
        notification_policy: JSON.stringify(goal.notification_policy),
        next_check_at: goal.next_check_at,
        created_at: goal.created_at,
        updated_at: goal.updated_at,
      })
      .execute();
    return goal;
  }

  async getGoal(
    input: PersonOwner & { goal_id: string },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<Goal | undefined> {
    const db = transaction ?? this.#db;
    const row = await this.#goalRow(db, input);
    return row === undefined ? undefined : toGoal(row);
  }

  async listGoals(input: ListGoalsInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPage<Goal>> {
    const db = transaction ?? this.#db;
    const cursor = input.page_token === undefined ? undefined : decodePageToken(GoalListCursorSchema, input.page_token);
    let query = db
      .selectFrom('goal')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by);
    if (input.lifecycle !== undefined) {
      query = query.where('lifecycle', '=', input.lifecycle);
    }
    if (cursor !== undefined) {
      query = query.where(eb =>
        eb.or([
          eb('updated_at', '<', cursor.updated_at),
          eb.and([eb('updated_at', '=', cursor.updated_at), eb('goal_id', '<', cursor.goal_id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('updated_at', 'desc')
      .orderBy('goal_id', 'desc')
      .limit(input.limit + 1)
      .execute();
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toGoal),
      next_page_token:
        rows.length > input.limit && last !== undefined
          ? encodePageToken(GoalListCursorSchema, { updated_at: toIso(last.updated_at), goal_id: last.goal_id })
          : undefined,
    };
  }

  async updateGoal(input: UpdateGoalInput, transaction?: Kysely<GoalDatabase>): Promise<Goal> {
    const run = async (db: Kysely<GoalDatabase>): Promise<Goal> => {
      const current = toGoal(await this.#requireGoal(db, input));
      if (current.revision !== input.expected_revision) {
        throw new GoalRevisionConflictError({
          record: 'goal',
          record_id: input.goal_id,
          expected_revision: input.expected_revision,
          actual_revision: current.revision,
        });
      }
      const nextLifecycle = input.patch.lifecycle ?? current.lifecycle;
      if (nextLifecycle !== current.lifecycle && !canTransitionGoalLifecycle(current.lifecycle, nextLifecycle)) {
        throw new GoalLifecycleTransitionError({ goal_id: input.goal_id, from: current.lifecycle, to: nextLifecycle });
      }
      if (input.fencing_token !== undefined) {
        const claim = await db
          .selectFrom('goal_claim')
          .selectAll()
          .where('goal_id', '=', input.goal_id)
          .executeTakeFirst();
        if (claim === undefined) {
          throw new GoalClaimFencedError({ goal_id: input.goal_id, fencing_token: input.fencing_token });
        }
        if (claim.fencing_token !== input.fencing_token || toIso(claim.expires_at) <= nowIso()) {
          throw new GoalClaimFencedError({ goal_id: input.goal_id, fencing_token: input.fencing_token });
        }
      }
      const timestamp = nowIso();
      const set: {
        title?: string;
        outcome?: string;
        success_criteria?: string;
        target_at?: string | null;
        timezone?: string | null;
        lifecycle?: string;
        pinned_agent_id?: string | null;
        pinned_agent_version?: string | null;
        pinned_agent_snapshot?: string | null;
        linked_space_id?: string | null;
        execution_policy?: string;
        notification_policy?: string;
        next_check_at?: string | null;
        revision: number;
        updated_at: string;
      } = { revision: input.expected_revision + 1, updated_at: timestamp };
      if (input.patch.title !== undefined) {
        set.title = input.patch.title;
      }
      if (input.patch.outcome !== undefined) {
        set.outcome = input.patch.outcome;
      }
      if (input.patch.success_criteria !== undefined) {
        set.success_criteria = JSON.stringify(input.patch.success_criteria);
      }
      if (input.patch.target_at !== undefined) {
        set.target_at = input.patch.target_at;
      }
      if (input.patch.timezone !== undefined) {
        set.timezone = input.patch.timezone;
      }
      if (input.patch.lifecycle !== undefined) {
        set.lifecycle = input.patch.lifecycle;
      }
      if (input.patch.pinned_agent_id !== undefined) {
        set.pinned_agent_id = input.patch.pinned_agent_id;
      }
      if (input.patch.pinned_agent_version !== undefined) {
        set.pinned_agent_version = input.patch.pinned_agent_version;
      }
      if (input.patch.pinned_agent_snapshot !== undefined) {
        set.pinned_agent_snapshot =
          input.patch.pinned_agent_snapshot === null ? null : JSON.stringify(input.patch.pinned_agent_snapshot);
      }
      if (input.patch.linked_space_id !== undefined) {
        set.linked_space_id = input.patch.linked_space_id;
      }
      if (input.patch.execution_policy !== undefined) {
        set.execution_policy = JSON.stringify(input.patch.execution_policy);
      }
      if (input.patch.notification_policy !== undefined) {
        set.notification_policy = JSON.stringify(input.patch.notification_policy);
      }
      if (input.patch.next_check_at !== undefined) {
        set.next_check_at = input.patch.next_check_at;
      }
      const row = await db
        .updateTable('goal')
        .set(set)
        .where('goal_id', '=', input.goal_id)
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .where('revision', '=', input.expected_revision)
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) {
        const actual = await this.#goalRow(db, input);
        if (actual === undefined) {
          throw new GoalNotFoundError(input.goal_id);
        }
        throw new GoalRevisionConflictError({
          record: 'goal',
          record_id: input.goal_id,
          expected_revision: input.expected_revision,
          actual_revision: actual.revision,
        });
      }
      if (input.wakeup !== undefined) {
        await this.#insertWakeup(db, input, input.wakeup);
      }
      return toGoal(row);
    };
    return transaction === undefined ? this.#db.transaction().execute(run) : run(transaction);
  }

  async deleteGoal(input: PersonOwner & { goal_id: string }, transaction?: Kysely<GoalDatabase>): Promise<void> {
    const db = transaction ?? this.#db;
    await db
      .deleteFrom('goal')
      .where('goal_id', '=', input.goal_id)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .execute();
  }

  async addStep(input: AddGoalStepInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPlanStep> {
    const db = transaction ?? this.#db;
    await this.#requireGoal(db, input);
    const timestamp = nowIso();
    const step = GoalPlanStepSchema.parse({
      step_id: input.step_id ?? newId(),
      goal_id: input.goal_id,
      description: input.description,
      depends_on: [...input.depends_on],
      status: input.status,
      acceptance_criteria: [...input.acceptance_criteria],
      evidence_ids: [...input.evidence_ids],
      action_id: input.action_id,
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });
    await db
      .insertInto('goal_step')
      .values({
        step_id: step.step_id,
        goal_id: step.goal_id,
        description: step.description,
        depends_on: JSON.stringify(step.depends_on),
        status: step.status,
        acceptance_criteria: JSON.stringify(step.acceptance_criteria),
        evidence_ids: JSON.stringify(step.evidence_ids),
        action_id: step.action_id,
        revision: step.revision,
        created_at: step.created_at,
        updated_at: step.updated_at,
      })
      .execute();
    return step;
  }

  async listSteps(
    input: PersonOwner & { goal_id: string },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<GoalPlanStep[]> {
    const db = transaction ?? this.#db;
    const goal = await this.#goalRow(db, input);
    if (goal === undefined) {
      return [];
    }
    const rows = await db
      .selectFrom('goal_step')
      .selectAll()
      .where('goal_id', '=', input.goal_id)
      .orderBy('created_at', 'asc')
      .orderBy('step_id', 'asc')
      .execute();
    return rows.map(toStep);
  }

  async updateStep(input: UpdateGoalStepInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPlanStep> {
    const db = transaction ?? this.#db;
    await this.#requireGoal(db, input);
    const current = await db
      .selectFrom('goal_step')
      .selectAll()
      .where('goal_id', '=', input.goal_id)
      .where('step_id', '=', input.step_id)
      .executeTakeFirst();
    if (current === undefined) {
      throw new GoalRecordNotFoundError({ record: 'step', record_id: input.step_id, goal_id: input.goal_id });
    }
    if (current.revision !== input.expected_revision) {
      throw new GoalRevisionConflictError({
        record: 'step',
        record_id: input.step_id,
        expected_revision: input.expected_revision,
        actual_revision: current.revision,
      });
    }
    const set: {
      description?: string;
      depends_on?: string;
      status?: string;
      acceptance_criteria?: string;
      evidence_ids?: string;
      action_id?: string | null;
      revision: number;
      updated_at: string;
    } = { revision: input.expected_revision + 1, updated_at: nowIso() };
    if (input.patch.description !== undefined) {
      set.description = input.patch.description;
    }
    if (input.patch.depends_on !== undefined) {
      set.depends_on = JSON.stringify(input.patch.depends_on);
    }
    if (input.patch.status !== undefined) {
      set.status = input.patch.status;
    }
    if (input.patch.acceptance_criteria !== undefined) {
      set.acceptance_criteria = JSON.stringify(input.patch.acceptance_criteria);
    }
    if (input.patch.evidence_ids !== undefined) {
      set.evidence_ids = JSON.stringify(input.patch.evidence_ids);
    }
    if (input.patch.action_id !== undefined) {
      set.action_id = input.patch.action_id;
    }
    const row = await db
      .updateTable('goal_step')
      .set(set)
      .where('goal_id', '=', input.goal_id)
      .where('step_id', '=', input.step_id)
      .where('revision', '=', input.expected_revision)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      throw new GoalRevisionConflictError({
        record: 'step',
        record_id: input.step_id,
        expected_revision: input.expected_revision,
        actual_revision: input.expected_revision,
      });
    }
    return toStep(row);
  }

  async addEvidence(input: AddGoalEvidenceInput, transaction?: Kysely<GoalDatabase>): Promise<GoalEvidence> {
    const db = transaction ?? this.#db;
    await this.#requireGoal(db, input);
    const evidence = GoalEvidenceSchema.parse({
      evidence_id: input.evidence_id ?? newId(),
      goal_id: input.goal_id,
      source_kind: input.source_kind,
      source_ref: input.source_ref,
      source_revision: input.source_revision,
      content_hash: input.content_hash,
      observed_at: input.observed_at,
      claimed_event_at: input.claimed_event_at,
      freshness: input.freshness,
      admission: input.admission,
      extraction_method: input.extraction_method,
    });
    await db
      .insertInto('goal_evidence')
      .values({
        evidence_id: evidence.evidence_id,
        goal_id: evidence.goal_id,
        source_kind: evidence.source_kind,
        source_ref: evidence.source_ref,
        source_revision: evidence.source_revision,
        content_hash: evidence.content_hash,
        observed_at: evidence.observed_at,
        claimed_event_at: evidence.claimed_event_at,
        freshness: evidence.freshness,
        admission: evidence.admission,
        extraction_method: evidence.extraction_method,
      })
      .execute();
    return evidence;
  }

  async listEvidence(
    input: ListGoalEvidenceInput,
    transaction?: Kysely<GoalDatabase>,
  ): Promise<GoalPage<GoalEvidence>> {
    const db = transaction ?? this.#db;
    const goal = await this.#goalRow(db, input);
    if (goal === undefined) {
      return { data: [], next_page_token: undefined };
    }
    const cursor = input.page_token === undefined ? undefined : decodePageToken(EvidenceCursorSchema, input.page_token);
    let query = db.selectFrom('goal_evidence').selectAll().where('goal_id', '=', input.goal_id);
    if (cursor !== undefined) {
      query = query.where(eb =>
        eb.or([
          eb('observed_at', '<', cursor.observed_at),
          eb.and([eb('observed_at', '=', cursor.observed_at), eb('evidence_id', '<', cursor.evidence_id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('observed_at', 'desc')
      .orderBy('evidence_id', 'desc')
      .limit(input.limit + 1)
      .execute();
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toEvidence),
      next_page_token:
        rows.length > input.limit && last !== undefined
          ? encodePageToken(EvidenceCursorSchema, {
              observed_at: toIso(last.observed_at),
              evidence_id: last.evidence_id,
            })
          : undefined,
    };
  }

  async appendEvent(input: AppendGoalEventInput, transaction?: Kysely<GoalDatabase>): Promise<GoalEvent> {
    if (transaction !== undefined) {
      return this.#appendEventOnce(input, transaction);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.#db.transaction().execute(db => this.#appendEventOnce(input, db));
      } catch (error) {
        if (!isUniqueViolationError(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError;
  }

  async #appendEventOnce(input: AppendGoalEventInput, db: Kysely<GoalDatabase>): Promise<GoalEvent> {
    await this.#requireGoal(db, input);
    const top = await db
      .selectFrom('goal_event')
      .select(eb => eb.fn.max<number>('sequence').as('max_sequence'))
      .where('goal_id', '=', input.goal_id)
      .executeTakeFirst();
    const sequence = (top?.max_sequence ?? 0) + 1;
    const event = GoalEventSchema.parse({
      event_id: newId(),
      goal_id: input.goal_id,
      sequence,
      event_type: input.event_type,
      actor: input.actor,
      payload: input.payload,
      created_at: nowIso(),
    });
    await db
      .insertInto('goal_event')
      .values({
        event_id: event.event_id,
        goal_id: event.goal_id,
        sequence: event.sequence,
        event_type: event.event_type,
        actor: event.actor,
        payload: JSON.stringify(event.payload),
        created_at: event.created_at,
      })
      .execute();
    return event;
  }

  async listEvents(input: ListGoalEventsInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPage<GoalEvent>> {
    const db = transaction ?? this.#db;
    const goal = await this.#goalRow(db, input);
    if (goal === undefined) {
      return { data: [], next_page_token: undefined };
    }
    const cursor = input.page_token === undefined ? undefined : decodePageToken(EventCursorSchema, input.page_token);
    let query = db.selectFrom('goal_event').selectAll().where('goal_id', '=', input.goal_id);
    if (cursor !== undefined) {
      query = query.where('sequence', '>', cursor.sequence);
    }
    const rows = await query
      .orderBy('sequence', 'asc')
      .limit(input.limit + 1)
      .execute();
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toEvent),
      next_page_token:
        rows.length > input.limit && last !== undefined
          ? encodePageToken(EventCursorSchema, { sequence: last.sequence })
          : undefined,
    };
  }

  async recordCycle(input: RecordGoalCycleInput, transaction?: Kysely<GoalDatabase>): Promise<GoalCycle> {
    const db = transaction ?? this.#db;
    await this.#requireGoal(db, input);
    const cycle = GoalCycleSchema.parse({
      cycle_id: input.cycle_id ?? newId(),
      goal_id: input.goal_id,
      input_revision: input.input_revision,
      trigger_ids: [...input.trigger_ids],
      lease: input.lease,
      budgets: input.budgets,
      usage: input.usage,
      started_at: input.started_at,
      finished_at: input.finished_at,
      outcome: input.outcome,
      outcome_detail: input.outcome_detail,
      next_check_at: input.next_check_at,
    });
    await db
      .insertInto('goal_cycle')
      .values({
        cycle_id: cycle.cycle_id,
        goal_id: cycle.goal_id,
        input_revision: cycle.input_revision,
        trigger_ids: JSON.stringify(cycle.trigger_ids),
        lease: cycle.lease === null ? null : JSON.stringify(cycle.lease),
        budgets: JSON.stringify(cycle.budgets),
        usage: JSON.stringify(cycle.usage),
        started_at: cycle.started_at,
        finished_at: cycle.finished_at,
        outcome: cycle.outcome,
        outcome_detail: cycle.outcome_detail,
        next_check_at: cycle.next_check_at,
      })
      .execute();
    return cycle;
  }

  async updateCycle(input: UpdateGoalCycleInput, transaction?: Kysely<GoalDatabase>): Promise<GoalCycle> {
    const db = transaction ?? this.#db;
    await this.#requireGoal(db, input);
    const set: {
      lease?: string | null;
      budgets?: string;
      usage?: string;
      finished_at?: string | null;
      outcome?: string | null;
      outcome_detail?: string | null;
      next_check_at?: string | null;
    } = {};
    if (input.patch.lease !== undefined) {
      set.lease = input.patch.lease === null ? null : JSON.stringify(input.patch.lease);
    }
    if (input.patch.budgets !== undefined) {
      set.budgets = JSON.stringify(input.patch.budgets);
    }
    if (input.patch.usage !== undefined) {
      set.usage = JSON.stringify(input.patch.usage);
    }
    if (input.patch.finished_at !== undefined) {
      set.finished_at = input.patch.finished_at;
    }
    if (input.patch.outcome !== undefined) {
      set.outcome = input.patch.outcome;
    }
    if (input.patch.outcome_detail !== undefined) {
      set.outcome_detail = input.patch.outcome_detail;
    }
    if (input.patch.next_check_at !== undefined) {
      set.next_check_at = input.patch.next_check_at;
    }
    const row = await db
      .updateTable('goal_cycle')
      .set(set)
      .where('goal_id', '=', input.goal_id)
      .where('cycle_id', '=', input.cycle_id)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      throw new GoalRecordNotFoundError({ record: 'cycle', record_id: input.cycle_id, goal_id: input.goal_id });
    }
    return toCycle(row);
  }

  async listCycles(input: ListGoalCyclesInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPage<GoalCycle>> {
    const db = transaction ?? this.#db;
    const goal = await this.#goalRow(db, input);
    if (goal === undefined) {
      return { data: [], next_page_token: undefined };
    }
    const cursor = input.page_token === undefined ? undefined : decodePageToken(CycleCursorSchema, input.page_token);
    let query = db.selectFrom('goal_cycle').selectAll().where('goal_id', '=', input.goal_id);
    if (cursor !== undefined) {
      query = query.where(eb =>
        eb.or([
          eb('started_at', '<', cursor.started_at),
          eb.and([eb('started_at', '=', cursor.started_at), eb('cycle_id', '<', cursor.cycle_id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('started_at', 'desc')
      .orderBy('cycle_id', 'desc')
      .limit(input.limit + 1)
      .execute();
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toCycle),
      next_page_token:
        rows.length > input.limit && last !== undefined
          ? encodePageToken(CycleCursorSchema, { started_at: toIso(last.started_at), cycle_id: last.cycle_id })
          : undefined,
    };
  }

  async recordAction(input: RecordGoalActionInput, transaction?: Kysely<GoalDatabase>): Promise<GoalAction> {
    const db = transaction ?? this.#db;
    await this.#requireGoal(db, input);
    const timestamp = nowIso();
    const action = GoalActionSchema.parse({
      action_id: input.action_id ?? newId(),
      goal_id: input.goal_id,
      cycle_id: input.cycle_id,
      expected_revision: input.expected_revision,
      preconditions: input.preconditions,
      tool_call_ref: input.tool_call_ref,
      approval_ref: input.approval_ref,
      execution_state: input.execution_state,
      receipt_ref: input.receipt_ref,
      created_at: timestamp,
      updated_at: timestamp,
    });
    await db
      .insertInto('goal_action')
      .values({
        action_id: action.action_id,
        goal_id: action.goal_id,
        cycle_id: action.cycle_id,
        expected_revision: action.expected_revision,
        preconditions: JSON.stringify(action.preconditions),
        tool_call_ref: action.tool_call_ref,
        approval_ref: action.approval_ref,
        execution_state: action.execution_state,
        receipt_ref: action.receipt_ref,
        created_at: action.created_at,
        updated_at: action.updated_at,
      })
      .execute();
    return action;
  }

  async updateAction(input: UpdateGoalActionInput, transaction?: Kysely<GoalDatabase>): Promise<GoalAction> {
    const db = transaction ?? this.#db;
    await this.#requireGoal(db, input);
    const set: {
      preconditions?: string;
      tool_call_ref?: string | null;
      approval_ref?: string | null;
      execution_state?: string;
      receipt_ref?: string | null;
      updated_at: string;
    } = { updated_at: nowIso() };
    if (input.patch.preconditions !== undefined) {
      set.preconditions = JSON.stringify(input.patch.preconditions);
    }
    if (input.patch.tool_call_ref !== undefined) {
      set.tool_call_ref = input.patch.tool_call_ref;
    }
    if (input.patch.approval_ref !== undefined) {
      set.approval_ref = input.patch.approval_ref;
    }
    if (input.patch.execution_state !== undefined) {
      set.execution_state = input.patch.execution_state;
    }
    if (input.patch.receipt_ref !== undefined) {
      set.receipt_ref = input.patch.receipt_ref;
    }
    const row = await db
      .updateTable('goal_action')
      .set(set)
      .where('goal_id', '=', input.goal_id)
      .where('action_id', '=', input.action_id)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      throw new GoalRecordNotFoundError({ record: 'action', record_id: input.action_id, goal_id: input.goal_id });
    }
    return toAction(row);
  }

  async listActions(input: ListGoalActionsInput, transaction?: Kysely<GoalDatabase>): Promise<GoalPage<GoalAction>> {
    const db = transaction ?? this.#db;
    const goal = await this.#goalRow(db, input);
    if (goal === undefined) {
      return { data: [], next_page_token: undefined };
    }
    const cursor = input.page_token === undefined ? undefined : decodePageToken(ActionCursorSchema, input.page_token);
    let query = db.selectFrom('goal_action').selectAll().where('goal_id', '=', input.goal_id);
    if (cursor !== undefined) {
      query = query.where(eb =>
        eb.or([
          eb('created_at', '<', cursor.created_at),
          eb.and([eb('created_at', '=', cursor.created_at), eb('action_id', '<', cursor.action_id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('action_id', 'desc')
      .limit(input.limit + 1)
      .execute();
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toAction),
      next_page_token:
        rows.length > input.limit && last !== undefined
          ? encodePageToken(ActionCursorSchema, { created_at: toIso(last.created_at), action_id: last.action_id })
          : undefined,
    };
  }

  async claimGoal(input: ClaimGoalInput, transaction?: Kysely<GoalDatabase>): Promise<GoalClaim | undefined> {
    const run = async (db: Kysely<GoalDatabase>): Promise<GoalClaim | undefined> => {
      await this.#requireGoal(db, input);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const existing = await db
          .selectFrom('goal_claim')
          .selectAll()
          .where('goal_id', '=', input.goal_id)
          .executeTakeFirst();
        const now = new Date();
        const timestamp = now.toISOString();
        if (existing === undefined) {
          const inserted = await db
            .insertInto('goal_claim')
            .values({
              goal_id: input.goal_id,
              tenant_id: input.tenant_id,
              created_by: input.created_by,
              fencing_token: 1,
              worker_id: input.worker_id,
              expires_at: new Date(now.getTime() + input.ttl_ms).toISOString(),
              updated_at: timestamp,
            })
            .onConflict(conflict => conflict.column('goal_id').doNothing())
            .returningAll()
            .executeTakeFirst();
          if (inserted !== undefined) {
            return toClaim(inserted);
          }
          continue;
        }
        if (existing.tenant_id !== input.tenant_id || existing.created_by !== input.created_by) {
          return undefined;
        }
        if (toIso(existing.expires_at) > timestamp) {
          return undefined;
        }
        const updated = await db
          .updateTable('goal_claim')
          .set({
            fencing_token: existing.fencing_token + 1,
            worker_id: input.worker_id,
            expires_at: new Date(now.getTime() + input.ttl_ms).toISOString(),
            updated_at: timestamp,
          })
          .where('goal_id', '=', input.goal_id)
          .where('fencing_token', '=', existing.fencing_token)
          .where('expires_at', '<=', timestamp)
          .returningAll()
          .executeTakeFirst();
        if (updated !== undefined) {
          return toClaim(updated);
        }
      }
      return undefined;
    };
    return transaction === undefined ? this.#db.transaction().execute(run) : run(transaction);
  }

  async renewClaim(input: RenewGoalClaimInput, transaction?: Kysely<GoalDatabase>): Promise<GoalClaim | undefined> {
    const db = transaction ?? this.#db;
    const now = new Date();
    const row = await db
      .updateTable('goal_claim')
      .set({
        expires_at: new Date(now.getTime() + input.ttl_ms).toISOString(),
        updated_at: now.toISOString(),
      })
      .where('goal_id', '=', input.goal_id)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('fencing_token', '=', input.fencing_token)
      .where('expires_at', '>', now.toISOString())
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toClaim(row);
  }

  async releaseClaim(
    input: PersonOwner & { goal_id: string; fencing_token: number },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    const row = await db
      .updateTable('goal_claim')
      .set({ expires_at: timestamp, updated_at: timestamp })
      .where('goal_id', '=', input.goal_id)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('fencing_token', '=', input.fencing_token)
      .where('expires_at', '>', timestamp)
      .returning('goal_id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async getClaim(
    input: PersonOwner & { goal_id: string },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<GoalClaim | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('goal_claim')
      .selectAll()
      .where('goal_id', '=', input.goal_id)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .executeTakeFirst();
    return row === undefined ? undefined : toClaim(row);
  }

  async #insertWakeup(
    db: Kysely<GoalDatabase>,
    owner: PersonOwner & { goal_id: string },
    wakeup: EnqueueGoalWakeupInput,
  ): Promise<{ wakeup: GoalWakeup; created: boolean }> {
    const timestamp = nowIso();
    const inserted = await db
      .insertInto('goal_wakeup')
      .values({
        wakeup_id: newId(),
        goal_id: owner.goal_id,
        tenant_id: owner.tenant_id,
        created_by: owner.created_by,
        event_key: wakeup.event_key,
        kind: wakeup.kind,
        payload: JSON.stringify(wakeup.payload),
        available_at: wakeup.available_at ?? timestamp,
        claimed_by: null,
        claim_expires_at: null,
        delivered_at: null,
        created_at: timestamp,
      })
      .onConflict(conflict => conflict.columns(['goal_id', 'event_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { wakeup: toWakeup(inserted), created: true };
    }
    const existing = await db
      .selectFrom('goal_wakeup')
      .selectAll()
      .where('goal_id', '=', owner.goal_id)
      .where('event_key', '=', wakeup.event_key)
      .executeTakeFirstOrThrow();
    return { wakeup: toWakeup(existing), created: false };
  }

  async enqueueWakeup(
    input: PersonOwner & { goal_id: string } & EnqueueGoalWakeupInput,
    transaction?: Kysely<GoalDatabase>,
  ): Promise<{ wakeup: GoalWakeup; created: boolean }> {
    const db = transaction ?? this.#db;
    await this.#requireGoal(db, input);
    return this.#insertWakeup(db, input, input);
  }

  async claimWakeups(input: ClaimGoalWakeupsInput, transaction?: Kysely<GoalDatabase>): Promise<GoalWakeup[]> {
    const run = async (db: Kysely<GoalDatabase>): Promise<GoalWakeup[]> => {
      const now = input.now ?? nowIso();
      const claimExpires = new Date(new Date(now).getTime() + input.ttl_ms).toISOString();
      const candidates = await db
        .selectFrom('goal_wakeup')
        .selectAll()
        .where('delivered_at', 'is', null)
        .where('available_at', '<=', now)
        .where(eb => eb.or([eb('claimed_by', 'is', null), eb('claim_expires_at', '<=', now)]))
        .orderBy('available_at', 'asc')
        .orderBy('created_at', 'asc')
        .limit(input.limit)
        .execute();
      const claimed: GoalWakeup[] = [];
      for (const candidate of candidates) {
        const row = await db
          .updateTable('goal_wakeup')
          .set({ claimed_by: input.worker_id, claim_expires_at: claimExpires })
          .where('wakeup_id', '=', candidate.wakeup_id)
          .where('delivered_at', 'is', null)
          .where(eb => eb.or([eb('claimed_by', 'is', null), eb('claim_expires_at', '<=', now)]))
          .returningAll()
          .executeTakeFirst();
        if (row !== undefined) {
          claimed.push(toWakeup(row));
        }
      }
      return claimed;
    };
    return transaction === undefined ? this.#db.transaction().execute(run) : run(transaction);
  }

  async markWakeupDelivered(
    input: { wakeup_id: string; worker_id: string },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('goal_wakeup')
      .set({ delivered_at: nowIso() })
      .where('wakeup_id', '=', input.wakeup_id)
      .where('claimed_by', '=', input.worker_id)
      .where('delivered_at', 'is', null)
      .returning('wakeup_id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async exportGoalData(input: PersonOwner, transaction?: Kysely<GoalDatabase>): Promise<GoalExportBundle> {
    const db = transaction ?? this.#db;
    const goalRows = await db
      .selectFrom('goal')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .orderBy('created_at', 'asc')
      .orderBy('goal_id', 'asc')
      .execute();
    if (goalRows.length === 0) {
      return { goals: [], steps: [], evidence: [], events: [], cycles: [], actions: [] };
    }
    const goalIds = goalRows.map(row => row.goal_id);
    const stepRows = await db
      .selectFrom('goal_step')
      .selectAll()
      .where('goal_id', 'in', goalIds)
      .orderBy('created_at', 'asc')
      .orderBy('step_id', 'asc')
      .execute();
    const evidenceRows = await db
      .selectFrom('goal_evidence')
      .selectAll()
      .where('goal_id', 'in', goalIds)
      .orderBy('observed_at', 'asc')
      .orderBy('evidence_id', 'asc')
      .execute();
    const eventRows = await db
      .selectFrom('goal_event')
      .selectAll()
      .where('goal_id', 'in', goalIds)
      .orderBy('goal_id', 'asc')
      .orderBy('sequence', 'asc')
      .execute();
    const cycleRows = await db
      .selectFrom('goal_cycle')
      .selectAll()
      .where('goal_id', 'in', goalIds)
      .orderBy('started_at', 'asc')
      .orderBy('cycle_id', 'asc')
      .execute();
    const actionRows = await db
      .selectFrom('goal_action')
      .selectAll()
      .where('goal_id', 'in', goalIds)
      .orderBy('created_at', 'asc')
      .orderBy('action_id', 'asc')
      .execute();
    return {
      goals: goalRows.map(toGoal),
      steps: stepRows.map(toStep),
      evidence: evidenceRows.map(toEvidence),
      events: eventRows.map(toEvent),
      cycles: cycleRows.map(toCycle),
      actions: actionRows.map(toAction),
    };
  }

  async importGoalData(
    input: PersonOwner & { bundle: GoalExportBundle },
    transaction?: Kysely<GoalDatabase>,
  ): Promise<{ goals_added: number }> {
    const run = async (db: Kysely<GoalDatabase>): Promise<{ goals_added: number }> => {
      const bundle = input.bundle;
      const addedGoalIds = new Set<string>();
      for (const batch of batches(bundle.goals)) {
        if (batch.length === 0) {
          continue;
        }
        const inserted = await db
          .insertInto('goal')
          .values(
            batch.map(goal => ({
              goal_id: goal.goal_id,
              tenant_id: input.tenant_id,
              created_by: input.created_by,
              persona_id: goal.persona_id,
              pinned_agent_id: goal.pinned_agent_id,
              pinned_agent_version: goal.pinned_agent_version,
              pinned_agent_snapshot:
                goal.pinned_agent_snapshot === null ? null : JSON.stringify(goal.pinned_agent_snapshot),
              title: goal.title,
              outcome: goal.outcome,
              success_criteria: JSON.stringify(goal.success_criteria),
              target_at: goal.target_at,
              timezone: goal.timezone,
              lifecycle: goal.lifecycle,
              revision: goal.revision,
              linked_space_id: goal.linked_space_id,
              execution_policy: JSON.stringify(goal.execution_policy),
              notification_policy: JSON.stringify(goal.notification_policy),
              next_check_at: goal.next_check_at,
              created_at: goal.created_at,
              updated_at: goal.updated_at,
            })),
          )
          .onConflict(conflict => conflict.column('goal_id').doNothing())
          .returning('goal_id')
          .execute();
        for (const row of inserted) {
          addedGoalIds.add(row.goal_id);
        }
      }
      const presentGoalIds = new Set(bundle.goals.map(goal => goal.goal_id));
      for (const batch of batches(bundle.steps.filter(step => presentGoalIds.has(step.goal_id)))) {
        if (batch.length === 0) {
          continue;
        }
        await db
          .insertInto('goal_step')
          .values(
            batch.map(step => ({
              step_id: step.step_id,
              goal_id: step.goal_id,
              description: step.description,
              depends_on: JSON.stringify(step.depends_on),
              status: step.status,
              acceptance_criteria: JSON.stringify(step.acceptance_criteria),
              evidence_ids: JSON.stringify(step.evidence_ids),
              action_id: step.action_id,
              revision: step.revision,
              created_at: step.created_at,
              updated_at: step.updated_at,
            })),
          )
          .onConflict(conflict => conflict.column('step_id').doNothing())
          .execute();
      }
      for (const batch of batches(bundle.evidence.filter(evidence => presentGoalIds.has(evidence.goal_id)))) {
        if (batch.length === 0) {
          continue;
        }
        await db
          .insertInto('goal_evidence')
          .values(
            batch.map(evidence => ({
              evidence_id: evidence.evidence_id,
              goal_id: evidence.goal_id,
              source_kind: evidence.source_kind,
              source_ref: evidence.source_ref,
              source_revision: evidence.source_revision,
              content_hash: evidence.content_hash,
              observed_at: evidence.observed_at,
              claimed_event_at: evidence.claimed_event_at,
              freshness: evidence.freshness,
              admission: evidence.admission,
              extraction_method: evidence.extraction_method,
            })),
          )
          .onConflict(conflict => conflict.column('evidence_id').doNothing())
          .execute();
      }
      for (const batch of batches(bundle.events.filter(event => presentGoalIds.has(event.goal_id)))) {
        if (batch.length === 0) {
          continue;
        }
        await db
          .insertInto('goal_event')
          .values(
            batch.map(event => ({
              event_id: event.event_id,
              goal_id: event.goal_id,
              sequence: event.sequence,
              event_type: event.event_type,
              actor: event.actor,
              payload: JSON.stringify(event.payload),
              created_at: event.created_at,
            })),
          )
          .onConflict(conflict => conflict.column('event_id').doNothing())
          .execute();
      }
      for (const batch of batches(bundle.cycles.filter(cycle => presentGoalIds.has(cycle.goal_id)))) {
        if (batch.length === 0) {
          continue;
        }
        await db
          .insertInto('goal_cycle')
          .values(
            batch.map(cycle => ({
              cycle_id: cycle.cycle_id,
              goal_id: cycle.goal_id,
              input_revision: cycle.input_revision,
              trigger_ids: JSON.stringify(cycle.trigger_ids),
              lease: cycle.lease === null ? null : JSON.stringify(cycle.lease),
              budgets: JSON.stringify(cycle.budgets),
              usage: JSON.stringify(cycle.usage),
              started_at: cycle.started_at,
              finished_at: cycle.finished_at,
              outcome: cycle.outcome,
              outcome_detail: cycle.outcome_detail,
              next_check_at: cycle.next_check_at,
            })),
          )
          .onConflict(conflict => conflict.column('cycle_id').doNothing())
          .execute();
      }
      for (const batch of batches(bundle.actions.filter(action => presentGoalIds.has(action.goal_id)))) {
        if (batch.length === 0) {
          continue;
        }
        await db
          .insertInto('goal_action')
          .values(
            batch.map(action => ({
              action_id: action.action_id,
              goal_id: action.goal_id,
              cycle_id: action.cycle_id,
              expected_revision: action.expected_revision,
              preconditions: JSON.stringify(action.preconditions),
              tool_call_ref: action.tool_call_ref,
              approval_ref: action.approval_ref,
              execution_state: action.execution_state,
              receipt_ref: action.receipt_ref,
              created_at: action.created_at,
              updated_at: action.updated_at,
            })),
          )
          .onConflict(conflict => conflict.column('action_id').doNothing())
          .execute();
      }
      return { goals_added: addedGoalIds.size };
    };
    return transaction === undefined ? this.#db.transaction().execute(run) : run(transaction);
  }
}
