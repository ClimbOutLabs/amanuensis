/**
 * Bridges the canonical goal store (db/goalStore.ts) to the port the goal
 * service runs on (goalStorePort.ts), so the service, API, and tools never see
 * the store's own record shapes.
 *
 * The two shapes differ in a few settled ways, and this file is where each one
 * is reconciled:
 * - The store scopes every row by tenant and owner together; the port's
 *   inputs carry the owner's subject id, and this adapter builds the store's
 *   owner from it.
 * - The goal's chosen agent, its selected sources, each step's source
 *   references, and the plan's step order are service-owned details with no
 *   store columns. They ride inside the goal's execution policy document,
 *   which the store carries unchanged and this layer owns the meaning of.
 *   They are merged into that document under the store's revision check, so
 *   a write that loses the race never applies a stale merge.
 * - The store's persona column is never empty, so a goal made outside a
 *   persona's chat stores the marker below; the marker never leaves this
 *   file, and the port record reports no persona.
 * - Evidence rows in the store carry no excerpt and no cycle link. The check
 *   that records evidence also records its excerpts on its finish event, and
 *   this adapter joins them back onto the rows it reads out. Evidence
 *   recorded any other way reports no excerpt and no cycle.
 * - A cycle's session id and an event's caller-stamped time have no store
 *   columns. The finish call returns the session id it was given; the store
 *   stamps event times itself.
 */
import type { TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  GoalLifecycleTransitionError as StoredGoalLifecycleTransitionError,
  GoalNotFoundError as StoredGoalNotFoundError,
  GoalRecordNotFoundError as StoredGoalRecordNotFoundError,
  GoalRevisionConflictError as StoredGoalRevisionConflictError,
  type GoalDatabase,
  type GoalPage,
  type IGoalStore as IStoredGoalStore,
  type GoalPatch as StoredGoalPatch,
  type GoalStepPatch as StoredGoalStepPatch,
} from '../../db/goalStore';
import type { PersonOwner } from '../../db/personOwner';
import {
  GoalExecutionPolicySchema,
  GoalNotificationPolicySchema,
  GoalSourceKindSchema,
  GoalSourceRefSchema,
  PinnedAgentSetupSchema,
} from '../../schemas/goal';
import {
  GoalJsonDocumentSchema,
  type GoalJsonDocument,
  type Goal as StoredGoal,
  type GoalAction as StoredGoalAction,
  type GoalCycle as StoredGoalCycle,
  type GoalEvent as StoredGoalEvent,
  type GoalEvidence as StoredGoalEvidence,
  type GoalPlanStep as StoredGoalPlanStep,
} from '../../schemas/goals';
import { newId } from '../../utils/id';
import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_NOTIFICATION_POLICY,
  GoalNotFoundError,
  GoalStateError,
} from './goalService';
import {
  GoalRevisionConflictError,
  type GoalActionRecord,
  type GoalCycleOutcome,
  type GoalCycleRecord,
  type GoalEventRecord,
  type GoalEvidenceRecord,
  type GoalExecutionPolicy,
  type GoalRecord,
  type GoalStepRecord,
  type IGoalStore,
  type PinnedAgentSetup,
} from './goalStorePort';

/** Stored in the persona column for a goal made outside a persona's chat; the store's column is never empty. */
const NO_PERSONA_ID = 'no-persona';

/** Page size for reads that walk a whole list behind the port's paging shape. */
const STORE_PAGE_SIZE = 200;

/** Bounds the whole-list walks, so a pathological store cannot page forever. */
const MAX_WHOLE_LIST_PAGES = 100;

/**
 * The service-owned part of the goal's execution policy document. Every field
 * is optional on read: a goal stored by another layer may carry a document
 * this layer did not write, and the missing pieces fall back to the defaults
 * rather than failing the read.
 */
const StoredExecutionDocumentSchema = z.object({
  ...GoalExecutionPolicySchema.partial().shape,
  agent_id: z.string().min(1).nullable().optional(),
  selected_sources: z.array(GoalSourceRefSchema).optional(),
  step_source_refs: z.record(z.string(), z.array(z.string())).optional(),
  step_order: z.array(z.string()).optional(),
});

const StoredNotificationDocumentSchema = z.object({
  ...GoalNotificationPolicySchema.partial().shape,
});

interface ExecutionDocument {
  policy: GoalExecutionPolicy;
  agent_id: string | null;
  selected_sources: GoalRecord['selected_sources'];
  step_source_refs: Record<string, string[]>;
  step_order: string[];
}

function executionDocumentOf(raw: GoalJsonDocument): ExecutionDocument {
  const parsed = StoredExecutionDocumentSchema.parse(raw);
  return {
    policy: {
      checks_per_day: parsed.checks_per_day ?? DEFAULT_EXECUTION_POLICY.checks_per_day,
      cycle_minutes: parsed.cycle_minutes ?? DEFAULT_EXECUTION_POLICY.cycle_minutes,
      model_call_limit: parsed.model_call_limit ?? DEFAULT_EXECUTION_POLICY.model_call_limit,
      tool_call_limit: parsed.tool_call_limit ?? DEFAULT_EXECUTION_POLICY.tool_call_limit,
      cycle_token_limit: parsed.cycle_token_limit ?? DEFAULT_EXECUTION_POLICY.cycle_token_limit,
      daily_token_allowance: parsed.daily_token_allowance ?? DEFAULT_EXECUTION_POLICY.daily_token_allowance,
    },
    agent_id: parsed.agent_id ?? null,
    selected_sources: parsed.selected_sources ?? [],
    step_source_refs: parsed.step_source_refs ?? {},
    step_order: parsed.step_order ?? [],
  };
}

function executionDocumentRecord(document: ExecutionDocument): GoalJsonDocument {
  return {
    checks_per_day: document.policy.checks_per_day,
    cycle_minutes: document.policy.cycle_minutes,
    model_call_limit: document.policy.model_call_limit,
    tool_call_limit: document.policy.tool_call_limit,
    cycle_token_limit: document.policy.cycle_token_limit,
    daily_token_allowance: document.policy.daily_token_allowance,
    agent_id: document.agent_id,
    selected_sources: document.selected_sources.map(source => ({
      source_kind: source.source_kind,
      source_ref: source.source_ref,
      label: source.label,
    })),
    step_source_refs: document.step_source_refs,
    step_order: document.step_order,
  };
}

function policyDocumentOf(policy: GoalExecutionPolicy): GoalJsonDocument {
  return {
    checks_per_day: policy.checks_per_day,
    cycle_minutes: policy.cycle_minutes,
    model_call_limit: policy.model_call_limit,
    tool_call_limit: policy.tool_call_limit,
    cycle_token_limit: policy.cycle_token_limit,
    daily_token_allowance: policy.daily_token_allowance,
  };
}

function notificationDocumentOf(raw: GoalJsonDocument): { digest: boolean } {
  const parsed = StoredNotificationDocumentSchema.parse(raw);
  return { digest: parsed.digest ?? DEFAULT_NOTIFICATION_POLICY.digest };
}

function pinnedSetupDocumentOf(setup: PinnedAgentSetup): GoalJsonDocument {
  return GoalJsonDocumentSchema.parse(setup);
}

function goalRecordOf(stored: StoredGoal): GoalRecord {
  const execution = executionDocumentOf(stored.execution_policy);
  return {
    goal_id: stored.goal_id,
    tenant_id: stored.tenant_id,
    created_by: {
      subject_id: stored.created_by,
      subject_type: 'user',
      subject_display_name: stored.created_by,
    },
    persona_id: stored.persona_id === NO_PERSONA_ID ? null : stored.persona_id,
    title: stored.title,
    outcome: stored.outcome,
    success_criteria: stored.success_criteria,
    target_at: stored.target_at,
    target_has_time: stored.target_has_time,
    timezone: stored.timezone ?? 'UTC',
    lifecycle: stored.lifecycle,
    revision: stored.revision,
    agent_id: execution.agent_id,
    selected_sources: execution.selected_sources,
    execution_policy: execution.policy,
    notification_policy: notificationDocumentOf(stored.notification_policy),
    linked_space_id: stored.linked_space_id,
    pinned_agent_id: stored.pinned_agent_id,
    pinned_agent_version: stored.pinned_agent_version,
    pinned_setup:
      stored.pinned_agent_snapshot === null ? null : PinnedAgentSetupSchema.parse(stored.pinned_agent_snapshot),
    next_check_at: stored.next_check_at,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
  };
}

function stepRecordOf(stored: StoredGoalPlanStep, source_refs: readonly string[]): GoalStepRecord {
  return {
    step_id: stored.step_id,
    goal_id: stored.goal_id,
    description: stored.description,
    depends_on: stored.depends_on,
    status: stored.status,
    // The store keeps one statement per entry; the port carries the text as one block.
    acceptance_criteria: stored.acceptance_criteria.join('\n'),
    source_refs,
    evidence_ids: stored.evidence_ids,
    action_id: stored.action_id,
  };
}

/** The stored plan order: steps the document names come first, in its order; any others keep the store's order. */
function orderedSteps(steps: readonly StoredGoalPlanStep[], step_order: readonly string[]): StoredGoalPlanStep[] {
  if (step_order.length === 0) {
    return [...steps];
  }
  const byId = new Map(steps.map(step => [step.step_id, step]));
  const placed = new Set<string>();
  const ordered: StoredGoalPlanStep[] = [];
  for (const step_id of step_order) {
    const step = byId.get(step_id);
    if (step !== undefined) {
      ordered.push(step);
      placed.add(step_id);
    }
  }
  for (const step of steps) {
    if (!placed.has(step.step_id)) {
      ordered.push(step);
    }
  }
  return ordered;
}

function evidenceRecordOf(stored: StoredGoalEvidence): GoalEvidenceRecord {
  return {
    evidence_id: stored.evidence_id,
    goal_id: stored.goal_id,
    cycle_id: null,
    source_kind: GoalSourceKindSchema.parse(stored.source_kind),
    source_ref: stored.source_ref,
    // The port carries one stamp: the source's revision, or the content hash when it has none.
    source_revision: stored.source_revision ?? stored.content_hash ?? '',
    observed_at: stored.observed_at,
    claimed_event_at: stored.claimed_event_at,
    freshness: stored.freshness,
    admission: stored.admission,
    extraction_method: stored.extraction_method,
    excerpt: '',
  };
}

const CYCLE_OUTCOMES: readonly GoalCycleOutcome[] = [
  'completed',
  'nothing_changed',
  'needs_decision',
  'budget_exhausted',
  'failed',
];

function cycleOutcomeOf(outcome: string | null): GoalCycleOutcome | null {
  if (outcome === null) {
    return null;
  }
  // The store leaves the outcome wording to the runner. An outcome this layer
  // does not know reads as failed rather than inventing a new state.
  return CYCLE_OUTCOMES.find(candidate => candidate === outcome) ?? 'failed';
}

function cycleRecordOf(stored: StoredGoalCycle): GoalCycleRecord {
  return {
    cycle_id: stored.cycle_id,
    goal_id: stored.goal_id,
    input_revision: stored.input_revision,
    trigger: stored.trigger_ids[0] ?? '',
    started_at: stored.started_at,
    finished_at: stored.finished_at,
    outcome: cycleOutcomeOf(stored.outcome),
    outcome_detail: stored.outcome_detail,
    session_id: null,
    next_check_at: stored.next_check_at,
  };
}

function actionRecordOf(stored: StoredGoalAction): GoalActionRecord {
  return {
    action_id: stored.action_id,
    goal_id: stored.goal_id,
    cycle_id: stored.cycle_id,
    expected_revision: stored.expected_revision,
    tool_call_ref: stored.tool_call_ref,
    approval_ref: stored.approval_ref,
    execution_state: stored.execution_state,
    receipt_ref: stored.receipt_ref,
    created_at: stored.created_at,
  };
}

function eventRecordOf(stored: StoredGoalEvent): GoalEventRecord {
  return {
    event_id: stored.event_id,
    goal_id: stored.goal_id,
    sequence: stored.sequence,
    event_type: stored.event_type,
    actor: stored.actor,
    payload: stored.payload,
    created_at: stored.created_at,
  };
}

function pageOf<T>(
  data: T[],
  limit: number,
  next_page_token: string | undefined,
): { data: T[]; pagination: TokenPagination } {
  return {
    data,
    pagination: { limit, ...(next_page_token === undefined ? {} : { next_page_token }) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface GoalStoreAdapterDeps {
  store: IStoredGoalStore;
  /**
   * The database the store runs on. Creation uses it to write a goal and its
   * plan as one transaction, so a draft never lands without its plan. Without
   * it, creation writes the goal and then its steps in order.
   */
  db?: Kysely<GoalDatabase> | undefined;
}

/**
 * The store the goal service runs on. Its writes run on the store's own
 * connection, and no caller in this layer hands it a transaction, so the
 * port's transaction parameter is typed never here, exactly as the goal
 * service declares the store it runs on.
 */
export function createGoalStoreAdapter(deps: GoalStoreAdapterDeps): IGoalStore {
  const store = deps.store;

  async function fetchAllPages<T>(fetchPage: (page_token: string | undefined) => Promise<GoalPage<T>>): Promise<T[]> {
    const all: T[] = [];
    let page_token: string | undefined;
    for (let page = 0; page < MAX_WHOLE_LIST_PAGES; page += 1) {
      const result = await fetchPage(page_token);
      all.push(...result.data);
      if (result.next_page_token === undefined) {
        return all;
      }
      page_token = result.next_page_token;
    }
    return all;
  }

  /**
   * Joins each evidence row to the check that recorded it. The check's finish
   * event names the cycle, the new evidence ids, and the excerpt kept for
   * each; rows no finish event names keep no cycle and no excerpt.
   */
  async function decorateEvidence(
    owner: PersonOwner,
    goal_id: string,
    records: GoalEvidenceRecord[],
    transaction: Kysely<GoalDatabase> | undefined,
  ): Promise<GoalEvidenceRecord[]> {
    if (records.length === 0) {
      return records;
    }
    const wanted = new Set(records.map(record => record.evidence_id));
    const events = await fetchAllPages(page_token =>
      store.listEvents(
        { ...owner, goal_id, limit: STORE_PAGE_SIZE, ...(page_token === undefined ? {} : { page_token }) },
        transaction,
      ),
    );
    const cycleByEvidence = new Map<string, string>();
    const excerptByEvidence = new Map<string, string>();
    for (const event of events) {
      if (event.event_type !== 'goal_check_finished') {
        continue;
      }
      const cycle_id = event.payload['cycle_id'];
      const new_evidence = event.payload['new_evidence'];
      if (typeof cycle_id !== 'string' || !Array.isArray(new_evidence)) {
        continue;
      }
      const excerpts = event.payload['evidence_excerpts'];
      for (const evidence_id of new_evidence) {
        if (typeof evidence_id !== 'string' || !wanted.has(evidence_id)) {
          continue;
        }
        cycleByEvidence.set(evidence_id, cycle_id);
        if (isRecord(excerpts)) {
          const excerpt = excerpts[evidence_id];
          if (typeof excerpt === 'string') {
            excerptByEvidence.set(evidence_id, excerpt);
          }
        }
      }
    }
    if (cycleByEvidence.size === 0) {
      return records;
    }
    return records.map(record => {
      const cycle_id = cycleByEvidence.get(record.evidence_id);
      if (cycle_id === undefined) {
        return record;
      }
      return { ...record, cycle_id, excerpt: excerptByEvidence.get(record.evidence_id) ?? record.excerpt };
    });
  }

  return {
    async createGoal(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by.subject_id };
      const step_ids = input.steps.map(() => newId());
      const step_source_refs: Record<string, string[]> = {};
      input.steps.forEach((step, index) => {
        const step_id = step_ids[index];
        if (step_id !== undefined) {
          step_source_refs[step_id] = [...step.source_refs];
        }
      });
      const execution: ExecutionDocument = {
        policy: input.execution_policy,
        agent_id: input.agent_id,
        selected_sources: [...input.selected_sources],
        step_source_refs,
        step_order: step_ids,
      };
      const write = async (trx: Kysely<GoalDatabase> | undefined): Promise<GoalRecord> => {
        const goal = await store.createGoal(
          {
            ...owner,
            persona_id: input.persona_id ?? NO_PERSONA_ID,
            pinned_agent_id: null,
            pinned_agent_version: null,
            pinned_agent_snapshot: null,
            title: input.title,
            outcome: input.outcome,
            success_criteria: [...input.success_criteria],
            target_at: input.target_at,
            target_has_time: input.target_has_time,
            timezone: input.timezone,
            lifecycle: 'draft',
            linked_space_id: input.linked_space_id,
            execution_policy: executionDocumentRecord(execution),
            notification_policy: { digest: input.notification_policy.digest },
            next_check_at: null,
          },
          trx,
        );
        for (const [index, step] of input.steps.entries()) {
          const step_id = step_ids[index];
          if (step_id === undefined) {
            continue;
          }
          await store.addStep(
            {
              ...owner,
              goal_id: goal.goal_id,
              step_id,
              description: step.description,
              depends_on: step.depends_on_indexes.flatMap(dependencyIndex => {
                const dependency_id = step_ids[dependencyIndex];
                return dependency_id === undefined ? [] : [dependency_id];
              }),
              status: step.status,
              acceptance_criteria: step.acceptance_criteria === '' ? [] : [step.acceptance_criteria],
              evidence_ids: [],
              action_id: null,
            },
            trx,
          );
        }
        return goalRecordOf(goal);
      };
      if (deps.db !== undefined) {
        return deps.db.transaction().execute(trx => write(trx));
      }
      return write(transaction);
    },

    async getGoal(input, transaction) {
      const stored = await store.getGoal(
        { tenant_id: input.tenant_id, created_by: input.created_by, goal_id: input.goal_id },
        transaction,
      );
      return stored === undefined ? undefined : goalRecordOf(stored);
    },

    async listGoals(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      const lifecycle = input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle };
      if (input.limit !== undefined) {
        const page = await store.listGoals(
          {
            ...owner,
            ...lifecycle,
            limit: input.limit,
            ...(input.page_token === undefined ? {} : { page_token: input.page_token }),
          },
          transaction,
        );
        return pageOf(page.data.map(goalRecordOf), input.limit, page.next_page_token);
      }
      const all = await fetchAllPages(page_token =>
        store.listGoals(
          { ...owner, ...lifecycle, limit: STORE_PAGE_SIZE, ...(page_token === undefined ? {} : { page_token }) },
          transaction,
        ),
      );
      return pageOf(all.map(goalRecordOf), Math.max(all.length, 1), undefined);
    },

    async updateGoal(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      const current = await store.getGoal({ ...owner, goal_id: input.goal_id }, transaction);
      if (current === undefined) {
        return undefined;
      }
      if (current.revision !== input.expected_revision) {
        throw new GoalRevisionConflictError({
          goal_id: input.goal_id,
          expected_revision: input.expected_revision,
          actual_revision: current.revision,
        });
      }
      const patch: StoredGoalPatch = {};
      if (input.lifecycle !== undefined) {
        patch.lifecycle = input.lifecycle;
      }
      if (input.pinned_setup !== undefined) {
        patch.pinned_agent_id = input.pinned_setup === null ? null : input.pinned_setup.agent_id;
        patch.pinned_agent_version = input.pinned_setup === null ? null : input.pinned_setup.agent_version;
        patch.pinned_agent_snapshot = input.pinned_setup === null ? null : pinnedSetupDocumentOf(input.pinned_setup);
      }
      const changes = input.patch;
      if (changes !== undefined) {
        if (changes.title !== undefined) {
          patch.title = changes.title;
        }
        if (changes.outcome !== undefined) {
          patch.outcome = changes.outcome;
        }
        if (changes.success_criteria !== undefined) {
          patch.success_criteria = [...changes.success_criteria];
        }
        if (changes.target_at !== undefined) {
          patch.target_at = changes.target_at;
        }
        if (changes.target_has_time !== undefined) {
          patch.target_has_time = changes.target_has_time;
        }
        if (changes.timezone !== undefined) {
          patch.timezone = changes.timezone;
        }
        if (changes.linked_space_id !== undefined) {
          patch.linked_space_id = changes.linked_space_id;
        }
        if (changes.next_check_at !== undefined) {
          patch.next_check_at = changes.next_check_at;
        }
        if (changes.notification_policy !== undefined) {
          patch.notification_policy = { digest: changes.notification_policy.digest };
        }
        if (
          changes.execution_policy !== undefined ||
          changes.selected_sources !== undefined ||
          changes.agent_id !== undefined
        ) {
          // Merged against the document the revision check just read, so the
          // store's own revision check refuses the write if the goal moved on.
          const document = executionDocumentOf(current.execution_policy);
          if (changes.execution_policy !== undefined) {
            document.policy = changes.execution_policy;
          }
          if (changes.selected_sources !== undefined) {
            document.selected_sources = [...changes.selected_sources];
          }
          if (changes.agent_id !== undefined) {
            document.agent_id = changes.agent_id;
          }
          patch.execution_policy = executionDocumentRecord(document);
        }
      }
      try {
        const updated = await store.updateGoal(
          { ...owner, goal_id: input.goal_id, expected_revision: input.expected_revision, patch },
          transaction,
        );
        return goalRecordOf(updated);
      } catch (error) {
        if (error instanceof StoredGoalNotFoundError) {
          return undefined;
        }
        if (error instanceof StoredGoalRevisionConflictError) {
          throw new GoalRevisionConflictError(
            {
              goal_id: input.goal_id,
              expected_revision: error.expected_revision,
              actual_revision: error.actual_revision,
            },
            { cause: error },
          );
        }
        if (error instanceof StoredGoalLifecycleTransitionError) {
          throw new GoalStateError('This goal cannot move to that state from the state it is in now.', {
            cause: error,
          });
        }
        throw error;
      }
    },

    async listSteps(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      const [steps, goal] = await Promise.all([
        store.listSteps({ ...owner, goal_id: input.goal_id }, transaction),
        store.getGoal({ ...owner, goal_id: input.goal_id }, transaction),
      ]);
      if (goal === undefined) {
        return [];
      }
      const document = executionDocumentOf(goal.execution_policy);
      return orderedSteps(steps, document.step_order).map(step =>
        stepRecordOf(step, document.step_source_refs[step.step_id] ?? []),
      );
    },

    async updateStep(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      const steps = await store.listSteps({ ...owner, goal_id: input.goal_id }, transaction);
      const current = steps.find(step => step.step_id === input.step_id);
      if (current === undefined) {
        return undefined;
      }
      const patch: StoredGoalStepPatch = {};
      if (input.status !== undefined) {
        patch.status = input.status;
      }
      if (input.evidence_ids !== undefined) {
        patch.evidence_ids = [...input.evidence_ids];
      }
      if (input.action_id !== undefined) {
        patch.action_id = input.action_id;
      }
      let updated: StoredGoalPlanStep;
      try {
        updated = await store.updateStep(
          {
            ...owner,
            goal_id: input.goal_id,
            step_id: input.step_id,
            expected_revision: current.revision,
            patch,
          },
          transaction,
        );
      } catch (error) {
        if (error instanceof StoredGoalNotFoundError || error instanceof StoredGoalRecordNotFoundError) {
          return undefined;
        }
        if (error instanceof StoredGoalRevisionConflictError) {
          throw new GoalRevisionConflictError(
            {
              goal_id: input.goal_id,
              expected_revision: error.expected_revision,
              actual_revision: error.actual_revision,
            },
            { cause: error },
          );
        }
        throw error;
      }
      const goal = await store.getGoal({ ...owner, goal_id: input.goal_id }, transaction);
      const source_refs =
        goal === undefined ? [] : (executionDocumentOf(goal.execution_policy).step_source_refs[input.step_id] ?? []);
      return stepRecordOf(updated, source_refs);
    },

    async addEvidence(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      let stored: StoredGoalEvidence;
      try {
        stored = await store.addEvidence(
          {
            ...owner,
            goal_id: input.goal_id,
            source_kind: input.source_kind,
            source_ref: input.source_ref,
            source_revision: input.source_revision,
            content_hash: null,
            observed_at: input.observed_at,
            claimed_event_at: input.claimed_event_at,
            freshness: input.freshness,
            admission: input.admission,
            extraction_method: input.extraction_method,
          },
          transaction,
        );
      } catch (error) {
        if (error instanceof StoredGoalNotFoundError) {
          throw new GoalNotFoundError(input.goal_id, { cause: error });
        }
        throw error;
      }
      // The row just written is this cycle's, with the excerpt the check read.
      return { ...evidenceRecordOf(stored), cycle_id: input.cycle_id, excerpt: input.excerpt };
    },

    async listEvidence(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      let records: GoalEvidenceRecord[];
      let result: { data: GoalEvidenceRecord[]; pagination: TokenPagination };
      if (input.limit !== undefined) {
        const page = await store.listEvidence(
          {
            ...owner,
            goal_id: input.goal_id,
            limit: input.limit,
            ...(input.page_token === undefined ? {} : { page_token: input.page_token }),
          },
          transaction,
        );
        records = page.data.map(evidenceRecordOf);
        result = pageOf(records, input.limit, page.next_page_token);
      } else {
        const all = await fetchAllPages(page_token =>
          store.listEvidence(
            {
              ...owner,
              goal_id: input.goal_id,
              limit: STORE_PAGE_SIZE,
              ...(page_token === undefined ? {} : { page_token }),
            },
            transaction,
          ),
        );
        records = all.map(evidenceRecordOf);
        result = pageOf(records, Math.max(records.length, 1), undefined);
      }
      const decorated = await decorateEvidence(owner, input.goal_id, records, transaction);
      return { data: decorated, pagination: result.pagination };
    },

    async startCycle(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      let stored: StoredGoalCycle;
      try {
        const goal = await store.getGoal({ ...owner, goal_id: input.goal_id }, transaction);
        if (goal === undefined) {
          throw new GoalNotFoundError(input.goal_id);
        }
        stored = await store.recordCycle(
          {
            ...owner,
            goal_id: input.goal_id,
            input_revision: input.input_revision,
            trigger_ids: [input.trigger],
            lease: null,
            budgets: policyDocumentOf(executionDocumentOf(goal.execution_policy).policy),
            usage: { model_calls: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0 },
            started_at: input.started_at,
            finished_at: null,
            outcome: null,
            outcome_detail: null,
            next_check_at: null,
          },
          transaction,
        );
      } catch (error) {
        if (error instanceof StoredGoalNotFoundError) {
          throw new GoalNotFoundError(input.goal_id, { cause: error });
        }
        throw error;
      }
      return cycleRecordOf(stored);
    },

    async finishCycle(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      let stored: StoredGoalCycle;
      try {
        stored = await store.updateCycle(
          {
            ...owner,
            goal_id: input.goal_id,
            cycle_id: input.cycle_id,
            patch: {
              finished_at: input.finished_at,
              outcome: input.outcome,
              outcome_detail: input.outcome_detail,
              next_check_at: input.next_check_at,
            },
          },
          transaction,
        );
      } catch (error) {
        if (error instanceof StoredGoalNotFoundError || error instanceof StoredGoalRecordNotFoundError) {
          return undefined;
        }
        throw error;
      }
      // The store has no session column; the record this call returns carries
      // the session the cycle ran in, and later reads report none.
      return { ...cycleRecordOf(stored), session_id: input.session_id };
    },

    async listWaitingActions(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      const all = await fetchAllPages(page_token =>
        store.listActions(
          {
            ...owner,
            goal_id: input.goal_id,
            limit: STORE_PAGE_SIZE,
            ...(page_token === undefined ? {} : { page_token }),
          },
          transaction,
        ),
      );
      // The store lists actions newest first; waiting approvals read oldest first.
      const waiting = all
        .filter(action => action.execution_state === 'waiting_for_approval')
        .map(actionRecordOf)
        .reverse();
      const parsedOffset = Number.parseInt(input.page_token ?? '', 10);
      const offset = Number.isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;
      const size = input.limit ?? Math.max(waiting.length, 1);
      const slice = waiting.slice(offset, offset + size);
      const nextOffset = offset + slice.length;
      return pageOf(slice, size, nextOffset < waiting.length ? String(nextOffset) : undefined);
    },

    async appendEvent(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      let stored: StoredGoalEvent;
      try {
        stored = await store.appendEvent(
          {
            ...owner,
            goal_id: input.goal_id,
            event_type: input.event_type,
            actor: input.actor,
            payload: input.payload,
          },
          transaction,
        );
      } catch (error) {
        if (error instanceof StoredGoalNotFoundError) {
          throw new GoalNotFoundError(input.goal_id, { cause: error });
        }
        throw error;
      }
      return eventRecordOf(stored);
    },

    async listEvents(input, transaction) {
      const owner: PersonOwner = { tenant_id: input.tenant_id, created_by: input.created_by };
      if (input.limit !== undefined) {
        const page = await store.listEvents(
          {
            ...owner,
            goal_id: input.goal_id,
            limit: input.limit,
            ...(input.page_token === undefined ? {} : { page_token: input.page_token }),
          },
          transaction,
        );
        return pageOf(page.data.map(eventRecordOf), input.limit, page.next_page_token);
      }
      const all = await fetchAllPages(page_token =>
        store.listEvents(
          {
            ...owner,
            goal_id: input.goal_id,
            limit: STORE_PAGE_SIZE,
            ...(page_token === undefined ? {} : { page_token }),
          },
          transaction,
        ),
      );
      return pageOf(all.map(eventRecordOf), Math.max(all.length, 1), undefined);
    },
  };
}
