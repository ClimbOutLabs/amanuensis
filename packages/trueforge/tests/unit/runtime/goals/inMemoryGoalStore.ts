/**
 * An in-memory IGoalStore for service, check, and API tests. It keeps the
 * port's rules honestly: revision-checked updates throw on a stale revision,
 * evidence lists newest first, events list in sequence order, and waiting
 * actions are those still in the waiting state.
 */
import type { TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import {
  GoalRevisionConflictError,
  type CreateGoalInput,
  type GoalActionRecord,
  type GoalCycleRecord,
  type GoalEventRecord,
  type GoalEvidenceRecord,
  type GoalRecord,
  type GoalStepRecord,
  type IGoalStore,
  type UpdateGoalInput,
} from '../../../../src/runtime/goals/goalStorePort';

function page<T>(
  items: readonly T[],
  limit: number | undefined,
  pageToken: string | undefined,
): { data: T[]; pagination: TokenPagination } {
  const size = limit ?? Math.max(items.length, 1);
  const offset = pageToken === undefined ? 0 : Number.parseInt(pageToken, 10);
  const data = items.slice(offset, offset + size);
  const nextOffset = offset + data.length;
  return {
    data: [...data],
    pagination: {
      limit: size,
      ...(nextOffset < items.length ? { next_page_token: String(nextOffset) } : {}),
    },
  };
}

export class InMemoryGoalStore implements IGoalStore {
  readonly goals = new Map<string, GoalRecord>();
  readonly steps = new Map<string, GoalStepRecord[]>();
  readonly evidence: GoalEvidenceRecord[] = [];
  readonly cycles = new Map<string, GoalCycleRecord>();
  readonly actions: GoalActionRecord[] = [];
  readonly events: GoalEventRecord[] = [];
  #counter = 0;
  #now: () => Date;

  constructor(now: () => Date = () => new Date('2026-11-18T12:00:00.000Z')) {
    this.#now = now;
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `${prefix}-${String(this.#counter)}`;
  }

  async createGoal(input: CreateGoalInput): Promise<GoalRecord> {
    await Promise.resolve();
    const goalId = this.#id('goal');
    const stamp = this.#now().toISOString();
    const stepIds = input.steps.map(() => this.#id('step'));
    const record: GoalRecord = {
      goal_id: goalId,
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      persona_id: input.persona_id,
      title: input.title,
      outcome: input.outcome,
      success_criteria: input.success_criteria,
      target_at: input.target_at,
      timezone: input.timezone,
      lifecycle: 'draft',
      revision: 1,
      agent_id: input.agent_id,
      selected_sources: input.selected_sources,
      execution_policy: input.execution_policy,
      notification_policy: input.notification_policy,
      linked_space_id: input.linked_space_id,
      pinned_agent_id: null,
      pinned_agent_version: null,
      pinned_setup: null,
      next_check_at: null,
      created_at: stamp,
      updated_at: stamp,
    };
    this.goals.set(goalId, record);
    this.steps.set(
      goalId,
      input.steps.map((step, index) => ({
        step_id: stepIds[index] ?? `step-${String(index)}`,
        goal_id: goalId,
        description: step.description,
        depends_on: step.depends_on_indexes.map(dependencyIndex => stepIds[dependencyIndex] ?? 'missing'),
        status: step.status,
        acceptance_criteria: step.acceptance_criteria,
        source_refs: step.source_refs,
        evidence_ids: [],
        action_id: null,
      })),
    );
    return record;
  }

  async getGoal(input: { tenant_id: string; goal_id: string }): Promise<GoalRecord | undefined> {
    await Promise.resolve();
    const goal = this.goals.get(input.goal_id);
    return goal?.tenant_id === input.tenant_id ? goal : undefined;
  }

  async listGoals(input: {
    tenant_id: string;
    created_by_subject_id?: string;
    lifecycle?: GoalRecord['lifecycle'];
    limit: number | undefined;
    page_token: string | undefined;
  }) {
    await Promise.resolve();
    const matching = [...this.goals.values()]
      .filter(goal => goal.tenant_id === input.tenant_id)
      .filter(
        goal => input.created_by_subject_id === undefined || goal.created_by.subject_id === input.created_by_subject_id,
      )
      .filter(goal => input.lifecycle === undefined || goal.lifecycle === input.lifecycle)
      .sort((left, right) => (left.created_at < right.created_at ? 1 : -1));
    return page(matching, input.limit, input.page_token);
  }

  async updateGoal(input: UpdateGoalInput): Promise<GoalRecord | undefined> {
    await Promise.resolve();
    const goal = await this.getGoal(input);
    if (goal === undefined) {
      return undefined;
    }
    if (goal.revision !== input.expected_revision) {
      throw new GoalRevisionConflictError({
        goal_id: goal.goal_id,
        expected_revision: input.expected_revision,
        actual_revision: goal.revision,
      });
    }
    const updated: GoalRecord = {
      ...goal,
      ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
      ...(input.patch === undefined ? {} : { ...input.patch }),
      ...(input.pinned_setup === undefined
        ? {}
        : {
            pinned_setup: input.pinned_setup,
            pinned_agent_id: input.pinned_setup === null ? null : input.pinned_setup.agent_id,
            pinned_agent_version: input.pinned_setup === null ? null : input.pinned_setup.agent_version,
          }),
      revision: goal.revision + 1,
      updated_at: this.#now().toISOString(),
    };
    this.goals.set(goal.goal_id, updated);
    return updated;
  }

  async listSteps(input: { tenant_id: string; goal_id: string }): Promise<GoalStepRecord[]> {
    await Promise.resolve();
    return [...(this.steps.get(input.goal_id) ?? [])];
  }

  async updateStep(input: {
    tenant_id: string;
    goal_id: string;
    step_id: string;
    status?: GoalStepRecord['status'];
    evidence_ids?: readonly string[];
    action_id?: string | null;
  }): Promise<GoalStepRecord | undefined> {
    await Promise.resolve();
    const steps = this.steps.get(input.goal_id) ?? [];
    const index = steps.findIndex(step => step.step_id === input.step_id);
    const existing = steps[index];
    if (existing === undefined) {
      return undefined;
    }
    const updated: GoalStepRecord = {
      ...existing,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.evidence_ids === undefined ? {} : { evidence_ids: input.evidence_ids }),
      ...(input.action_id === undefined ? {} : { action_id: input.action_id }),
    };
    steps[index] = updated;
    return updated;
  }

  async addEvidence(
    input: Omit<GoalEvidenceRecord, 'evidence_id'> & { tenant_id: string },
  ): Promise<GoalEvidenceRecord> {
    await Promise.resolve();
    const { tenant_id, ...rest } = input;
    void tenant_id;
    const record: GoalEvidenceRecord = { evidence_id: this.#id('evidence'), ...rest };
    this.evidence.unshift(record);
    return record;
  }

  async listEvidence(input: {
    tenant_id: string;
    goal_id: string;
    limit: number | undefined;
    page_token: string | undefined;
  }) {
    await Promise.resolve();
    return page(
      this.evidence.filter(evidence => evidence.goal_id === input.goal_id),
      input.limit,
      input.page_token,
    );
  }

  async startCycle(input: {
    tenant_id: string;
    goal_id: string;
    input_revision: number;
    trigger: string;
    started_at: string;
  }): Promise<GoalCycleRecord> {
    await Promise.resolve();
    const record: GoalCycleRecord = {
      cycle_id: this.#id('cycle'),
      goal_id: input.goal_id,
      input_revision: input.input_revision,
      trigger: input.trigger,
      started_at: input.started_at,
      finished_at: null,
      outcome: null,
      outcome_detail: null,
      session_id: null,
      next_check_at: null,
    };
    this.cycles.set(record.cycle_id, record);
    return record;
  }

  async finishCycle(input: {
    tenant_id: string;
    goal_id: string;
    cycle_id: string;
    finished_at: string;
    outcome: NonNullable<GoalCycleRecord['outcome']>;
    outcome_detail: string | null;
    session_id: string | null;
    next_check_at: string | null;
  }): Promise<GoalCycleRecord | undefined> {
    await Promise.resolve();
    const existing = this.cycles.get(input.cycle_id);
    if (existing === undefined) {
      return undefined;
    }
    const updated: GoalCycleRecord = {
      ...existing,
      finished_at: input.finished_at,
      outcome: input.outcome,
      outcome_detail: input.outcome_detail,
      session_id: input.session_id,
      next_check_at: input.next_check_at,
    };
    this.cycles.set(updated.cycle_id, updated);
    return updated;
  }

  async listWaitingActions(input: {
    tenant_id: string;
    goal_id: string;
    limit: number | undefined;
    page_token: string | undefined;
  }) {
    await Promise.resolve();
    return page(
      this.actions.filter(
        action => action.goal_id === input.goal_id && action.execution_state === 'waiting_for_approval',
      ),
      input.limit,
      input.page_token,
    );
  }

  /** Test helper: place an action on a goal, as the approvals work will. */
  seedAction(action: GoalActionRecord): void {
    this.actions.push(action);
  }

  async appendEvent(input: {
    tenant_id: string;
    goal_id: string;
    event_type: string;
    actor: string;
    payload: Record<string, unknown>;
    created_at: string;
  }): Promise<GoalEventRecord> {
    await Promise.resolve();
    const sequence = this.events.filter(event => event.goal_id === input.goal_id).length + 1;
    const record: GoalEventRecord = {
      event_id: this.#id('event'),
      goal_id: input.goal_id,
      sequence,
      event_type: input.event_type,
      actor: input.actor,
      payload: input.payload,
      created_at: input.created_at,
    };
    this.events.push(record);
    return record;
  }

  async listEvents(input: {
    tenant_id: string;
    goal_id: string;
    limit: number | undefined;
    page_token: string | undefined;
  }) {
    await Promise.resolve();
    return page(
      this.events.filter(event => event.goal_id === input.goal_id),
      input.limit,
      input.page_token,
    );
  }
}
