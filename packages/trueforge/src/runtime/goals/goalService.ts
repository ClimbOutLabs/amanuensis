/**
 * The goal service: the one place goal lifecycle rules live, used by the Goals
 * API and the goal tools alike. Every operation checks the owner (and the
 * persona, when the call comes from a persona's chat) before it reads or
 * writes, every state change goes through the store's revision check, and
 * every change is recorded as a goal event.
 */
import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type { IAgentStore } from '../../db/agentStore';
import type { ISkillStore } from '../../db/skillStore';
import { GoalSetupResolutionError, resolvePinnedSetup } from './goalPinning';
import {
  GoalRevisionConflictError,
  type GoalCycleRecord,
  type GoalEvidenceRecord,
  type GoalExecutionPolicy,
  type GoalLifecycle,
  type GoalNotificationPolicy,
  type GoalPatch,
  type GoalRecord,
  type GoalSourceRef,
  type GoalStepRecord,
  type IGoalStore,
  type PinnedAgentSetup,
} from './goalStorePort';

/** Pilot limits from spec section 7: a starting point the card can raise per goal. */
export const DEFAULT_EXECUTION_POLICY: GoalExecutionPolicy = {
  checks_per_day: 1,
  cycle_minutes: 15,
  model_call_limit: 12,
  tool_call_limit: 40,
  cycle_token_limit: 300_000,
  daily_token_allowance: 1_000_000,
};

export const DEFAULT_NOTIFICATION_POLICY: GoalNotificationPolicy = { digest: true };

/** Who is calling: the owner, and the persona when the call comes from a persona's chat. */
export interface GoalActor {
  tenant_id: string;
  subject_id: string;
  persona_id?: string | undefined;
}

/** No goal by that id for this caller. Another owner's goal reads the same way, so nothing leaks. */
export class GoalNotFoundError extends Error {
  readonly goal_id: string;

  constructor(goal_id: string, options?: ErrorOptions) {
    super(`Goal not found: ${goal_id}`, options);
    this.name = 'GoalNotFoundError';
    this.goal_id = goal_id;
  }
}

/** The goal is in a state that does not allow this operation. The message says what to do instead. */
export class GoalStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GoalStateError';
  }
}

/**
 * Activation refused: the agent setup changed after the card was shown. Carries
 * the fresh resolution, so the caller can show the updated card and ask again.
 */
export class GoalSetupChangedError extends Error {
  readonly goal_id: string;
  readonly goal: GoalRecord;
  readonly current_setup: PinnedAgentSetup;

  constructor(input: { goal: GoalRecord; current_setup: PinnedAgentSetup }, options?: ErrorOptions) {
    super('The agent setup changed since the card was shown. Review the updated card, then activate again.', options);
    this.name = 'GoalSetupChangedError';
    this.goal_id = input.goal.goal_id;
    this.goal = input.goal;
    this.current_setup = input.current_setup;
  }
}

export interface GoalDraftStepInput {
  description: string;
  depends_on_indexes?: readonly number[];
  acceptance_criteria: string;
  source_refs?: readonly string[];
}

export interface CreateGoalDraftInput {
  agent_id: string | null;
  title: string;
  outcome: string;
  success_criteria: readonly string[];
  target_at: string | null;
  /** Whether the person gave the target a time of day. Defaults to false, a date alone. */
  target_has_time?: boolean;
  timezone: string;
  selected_sources: readonly GoalSourceRef[];
  steps: readonly GoalDraftStepInput[];
  execution_policy?: GoalExecutionPolicy;
  notification_policy?: GoalNotificationPolicy;
  linked_space_id?: string | null;
}

export interface GoalWithSteps {
  goal: GoalRecord;
  steps: GoalStepRecord[];
}

/** The step work turns to next: the first ready step whose dependencies are all met. */
export function nextStepOf(steps: readonly GoalStepRecord[]): GoalStepRecord | undefined {
  const met = new Set(
    steps.filter(step => step.status === 'verified' || step.status === 'owner_confirmed').map(step => step.step_id),
  );
  return steps.find(
    step =>
      (step.status === 'ready' || step.status === 'in_progress') &&
      step.depends_on.every(dependency => met.has(dependency)),
  );
}

/** The steps a finished step unblocks: planned steps whose dependencies are now all met. */
export function unblockedSteps(steps: readonly GoalStepRecord[]): GoalStepRecord[] {
  const met = new Set(
    steps.filter(step => step.status === 'verified' || step.status === 'owner_confirmed').map(step => step.step_id),
  );
  return steps.filter(step => step.status === 'planned' && step.depends_on.every(dependency => met.has(dependency)));
}

export interface GoalServiceDeps {
  store: IGoalStore;
  agentStore: Pick<IAgentStore, 'getAgent'>;
  skillStore: Pick<ISkillStore, 'listSkills'>;
  now?: () => Date;
}

export function createGoalService(deps: GoalServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const store = deps.store;

  function actorSubject(actor: GoalActor): CreatedBySubject {
    return { subject_id: actor.subject_id, subject_type: 'user', subject_display_name: actor.subject_id };
  }

  /** Owner check first, then the persona binding when the call comes from a persona's chat. */
  function checkAccess(actor: GoalActor, goal: GoalRecord): void {
    if (goal.created_by.subject_id !== actor.subject_id) {
      throw new GoalNotFoundError(goal.goal_id);
    }
    if (actor.persona_id !== undefined && goal.persona_id !== null && actor.persona_id !== goal.persona_id) {
      throw new GoalNotFoundError(goal.goal_id);
    }
  }

  async function loadGoal(actor: GoalActor, goal_id: string): Promise<GoalRecord> {
    const goal = await store.getGoal({ tenant_id: actor.tenant_id, created_by: actor.subject_id, goal_id });
    if (goal === undefined) {
      throw new GoalNotFoundError(goal_id);
    }
    checkAccess(actor, goal);
    return goal;
  }

  async function loadGoalWithSteps(actor: GoalActor, goal_id: string): Promise<GoalWithSteps> {
    const goal = await loadGoal(actor, goal_id);
    const steps = await store.listSteps({ tenant_id: actor.tenant_id, created_by: actor.subject_id, goal_id });
    return { goal, steps };
  }

  async function recordEvent(input: {
    actor: GoalActor;
    goal_id: string;
    event_type: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await store.appendEvent({
      tenant_id: input.actor.tenant_id,
      created_by: input.actor.subject_id,
      goal_id: input.goal_id,
      event_type: input.event_type,
      actor: input.actor.subject_id,
      payload: input.payload,
      created_at: now().toISOString(),
    });
  }

  /** A revision-checked lifecycle move plus its event, in one place so no caller can do one without the other. */
  async function transition(input: {
    actor: GoalActor;
    goal: GoalRecord;
    lifecycle: GoalLifecycle;
    event_type: string;
    payload?: Record<string, unknown>;
    patch?: GoalPatch;
    pinned_setup?: PinnedAgentSetup | null;
  }): Promise<GoalRecord> {
    const updated = await store.updateGoal({
      tenant_id: input.actor.tenant_id,
      created_by: input.actor.subject_id,
      goal_id: input.goal.goal_id,
      expected_revision: input.goal.revision,
      lifecycle: input.lifecycle,
      ...(input.patch === undefined ? {} : { patch: input.patch }),
      ...(input.pinned_setup === undefined ? {} : { pinned_setup: input.pinned_setup }),
    });
    if (updated === undefined) {
      throw new GoalNotFoundError(input.goal.goal_id);
    }
    await recordEvent({
      actor: input.actor,
      goal_id: input.goal.goal_id,
      event_type: input.event_type,
      payload: { from: input.goal.lifecycle, to: input.lifecycle, revision: updated.revision, ...input.payload },
    });
    return updated;
  }

  async function resolveSetup(actor: GoalActor, goal: GoalRecord): Promise<PinnedAgentSetup> {
    if (goal.agent_id === null) {
      throw new GoalStateError('This goal has no agent yet. Pick the agent that will do the work, then activate.');
    }
    const agent = await deps.agentStore.getAgent({ tenant_id: actor.tenant_id, id: goal.agent_id });
    if (agent === undefined) {
      throw new GoalStateError('The agent this goal runs as is no longer there. Pick another agent, then activate.');
    }
    return resolvePinnedSetup({ agent, skillStore: deps.skillStore, tenant_id: actor.tenant_id, now: now() });
  }

  return {
    /** The store this service runs on, for the check runner's cycle and evidence writes. */
    store,

    async createDraft(actor: GoalActor, input: CreateGoalDraftInput): Promise<GoalWithSteps> {
      const steps = input.steps.map(step => ({
        description: step.description,
        depends_on_indexes: step.depends_on_indexes ?? [],
        status: (step.depends_on_indexes ?? []).length === 0 ? ('ready' as const) : ('planned' as const),
        acceptance_criteria: step.acceptance_criteria,
        source_refs: step.source_refs ?? [],
      }));
      const goal = await store.createGoal({
        tenant_id: actor.tenant_id,
        created_by: actorSubject(actor),
        persona_id: actor.persona_id ?? null,
        title: input.title,
        outcome: input.outcome,
        success_criteria: input.success_criteria,
        target_at: input.target_at,
        target_has_time: input.target_has_time ?? false,
        timezone: input.timezone,
        agent_id: input.agent_id,
        selected_sources: input.selected_sources,
        execution_policy: input.execution_policy ?? DEFAULT_EXECUTION_POLICY,
        notification_policy: input.notification_policy ?? DEFAULT_NOTIFICATION_POLICY,
        linked_space_id: input.linked_space_id ?? null,
        steps,
      });
      await recordEvent({
        actor,
        goal_id: goal.goal_id,
        event_type: 'goal_created',
        payload: { title: goal.title, revision: goal.revision },
      });
      const storedSteps = await store.listSteps({
        tenant_id: actor.tenant_id,
        created_by: actor.subject_id,
        goal_id: goal.goal_id,
      });
      return { goal, steps: storedSteps };
    },

    async getGoal(actor: GoalActor, goal_id: string): Promise<GoalWithSteps> {
      return loadGoalWithSteps(actor, goal_id);
    },

    async listGoals(
      actor: GoalActor,
      input: { lifecycle?: GoalLifecycle; limit: number | undefined; page_token: string | undefined },
    ) {
      return store.listGoals({
        tenant_id: actor.tenant_id,
        created_by: actor.subject_id,
        ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
        limit: input.limit,
        page_token: input.page_token,
      });
    },

    async updateGoal(
      actor: GoalActor,
      goal_id: string,
      input: { expected_revision: number; patch: GoalPatch },
    ): Promise<GoalWithSteps> {
      const goal = await loadGoal(actor, goal_id);
      if (goal.revision !== input.expected_revision) {
        throw new GoalRevisionConflictError({
          goal_id,
          expected_revision: input.expected_revision,
          actual_revision: goal.revision,
        });
      }
      if (goal.lifecycle !== 'draft') {
        const material =
          input.patch.outcome !== undefined ||
          input.patch.success_criteria !== undefined ||
          input.patch.selected_sources !== undefined ||
          input.patch.target_at !== undefined ||
          input.patch.target_has_time !== undefined ||
          input.patch.agent_id !== undefined;
        if (material) {
          throw new GoalStateError(
            'This goal is already active, and that change alters what it is working toward. ' +
              'Changing it needs a new activation card, so the change is reviewed before it takes effect.',
          );
        }
      }
      const updated = await store.updateGoal({
        tenant_id: actor.tenant_id,
        created_by: actor.subject_id,
        goal_id,
        expected_revision: input.expected_revision,
        patch: input.patch,
      });
      if (updated === undefined) {
        throw new GoalNotFoundError(goal_id);
      }
      await recordEvent({
        actor,
        goal_id,
        event_type: 'goal_updated',
        payload: { revision: updated.revision, fields: Object.keys(input.patch) },
      });
      return loadGoalWithSteps(actor, goal_id);
    },

    /** What the activation card shows: the goal as it stands, plus the setup resolved right now. */
    async previewActivation(
      actor: GoalActor,
      goal_id: string,
    ): Promise<{ goal: GoalRecord; steps: GoalStepRecord[]; setup: PinnedAgentSetup }> {
      const { goal, steps } = await loadGoalWithSteps(actor, goal_id);
      const setup = await resolveSetup(actor, goal);
      return { goal, steps, setup };
    },

    /**
     * Activate against the card the owner reviewed. The setup is resolved again here;
     * if it no longer matches the digest the card showed, activation refuses and the
     * error carries the fresh setup, so the caller shows the updated card instead.
     */
    async activate(
      actor: GoalActor,
      goal_id: string,
      input: { expected_revision: number; setup_digest: string },
    ): Promise<GoalWithSteps> {
      const goal = await loadGoal(actor, goal_id);
      if (goal.lifecycle !== 'draft' && goal.lifecycle !== 'paused' && goal.lifecycle !== 'active') {
        throw new GoalStateError('This goal has ended, so it cannot be activated. Start a new goal instead.');
      }
      const setup = await resolveSetup(actor, goal);
      // A card is stale in the same way whether the goal moved on or the setup did:
      // what the owner reviewed is not what would be activated, so both refuse with
      // the fresh card rather than activating something unreviewed.
      if (goal.revision !== input.expected_revision || setup.digest !== input.setup_digest) {
        throw new GoalSetupChangedError({ goal, current_setup: setup });
      }
      const nextCheck = new Date(now().getTime() + (24 * 60 * 60 * 1000) / goal.execution_policy.checks_per_day);
      const updated = await transition({
        actor,
        goal,
        lifecycle: 'active',
        event_type: goal.pinned_setup === null ? 'goal_activated' : 'goal_setup_confirmed',
        payload: { setup_digest: setup.digest, agent_id: setup.agent_id },
        patch: { next_check_at: nextCheck.toISOString() },
        pinned_setup: setup,
      });
      return loadGoalWithSteps(actor, updated.goal_id);
    },

    async pause(actor: GoalActor, goal_id: string, input: { expected_revision: number }): Promise<GoalWithSteps> {
      const goal = await loadGoal(actor, goal_id);
      if (goal.revision !== input.expected_revision) {
        throw new GoalRevisionConflictError({
          goal_id,
          expected_revision: input.expected_revision,
          actual_revision: goal.revision,
        });
      }
      if (goal.lifecycle !== 'active') {
        throw new GoalStateError('Only an active goal can be paused. This goal is not running.');
      }
      // Pausing stops new dispatch. Approvals already waiting are invalidated with the
      // lifecycle move; the approval records themselves are settled by the approvals work.
      const updated = await transition({
        actor,
        goal,
        lifecycle: 'paused',
        event_type: 'goal_paused',
        payload: { approvals_invalidated: true },
      });
      return loadGoalWithSteps(actor, updated.goal_id);
    },

    async resume(actor: GoalActor, goal_id: string, input: { expected_revision: number }): Promise<GoalWithSteps> {
      const goal = await loadGoal(actor, goal_id);
      if (goal.revision !== input.expected_revision) {
        throw new GoalRevisionConflictError({
          goal_id,
          expected_revision: input.expected_revision,
          actual_revision: goal.revision,
        });
      }
      if (goal.lifecycle !== 'paused') {
        throw new GoalStateError('Only a paused goal can be resumed. This goal is not paused.');
      }
      const updated = await transition({ actor, goal, lifecycle: 'active', event_type: 'goal_resumed' });
      return loadGoalWithSteps(actor, updated.goal_id);
    },

    async end(actor: GoalActor, goal_id: string, input: { expected_revision: number }): Promise<GoalWithSteps> {
      const goal = await loadGoal(actor, goal_id);
      if (goal.revision !== input.expected_revision) {
        throw new GoalRevisionConflictError({
          goal_id,
          expected_revision: input.expected_revision,
          actual_revision: goal.revision,
        });
      }
      if (goal.lifecycle === 'ended' || goal.lifecycle === 'completed') {
        throw new GoalStateError('This goal is already finished. Its history stays as it is.');
      }
      const updated = await transition({
        actor,
        goal,
        lifecycle: 'ended',
        event_type: 'goal_ended',
        payload: { approvals_invalidated: true },
      });
      return loadGoalWithSteps(actor, updated.goal_id);
    },

    /**
     * The owner's word that a step is done. The step is marked owner_confirmed,
     * steps waiting on it become ready, and the confirmation is recorded as an
     * event naming who confirmed and which step. Confirming never completes
     * the goal and never verifies any other step: finishing the goal stays a
     * separate decision, and judging a step against its criteria stays with
     * the work that reads content.
     */
    async confirmStep(actor: GoalActor, goal_id: string, step_id: string): Promise<GoalWithSteps> {
      const { goal, steps } = await loadGoalWithSteps(actor, goal_id);
      if (goal.lifecycle === 'draft') {
        throw new GoalStateError('This goal is still a draft. Activate it before confirming one of its steps.');
      }
      if (goal.lifecycle === 'completed' || goal.lifecycle === 'ended') {
        throw new GoalStateError('This goal has finished, so its steps can no longer be confirmed.');
      }
      const step = steps.find(candidate => candidate.step_id === step_id);
      if (step === undefined) {
        throw new GoalNotFoundError(goal_id);
      }
      if (step.status === 'owner_confirmed') {
        throw new GoalStateError('This step is already confirmed. There is nothing more to do.');
      }
      if (step.status === 'verified') {
        throw new GoalStateError('This step is already verified. There is nothing to confirm.');
      }
      const updated = await store.updateStep({
        tenant_id: actor.tenant_id,
        created_by: actor.subject_id,
        goal_id,
        step_id,
        status: 'owner_confirmed',
      });
      if (updated === undefined) {
        throw new GoalNotFoundError(goal_id);
      }
      // Steps this confirmation unblocks become ready, the same promotion a check runs.
      const currentSteps = await store.listSteps({
        tenant_id: actor.tenant_id,
        created_by: actor.subject_id,
        goal_id,
      });
      for (const unblocked of unblockedSteps(currentSteps)) {
        await store.updateStep({
          tenant_id: actor.tenant_id,
          created_by: actor.subject_id,
          goal_id,
          step_id: unblocked.step_id,
          status: 'ready',
        });
      }
      await recordEvent({
        actor,
        goal_id,
        event_type: 'goal_step_confirmed',
        payload: { step_id, confirmed_by: actor.subject_id, from: step.status, to: 'owner_confirmed' },
      });
      return loadGoalWithSteps(actor, goal_id);
    },

    /**
     * The state a check may run from, with the pin verified against the saved agent:
     * a changed setup stops dispatch until the owner confirms an updated card.
     */
    async loadGoalForCheck(
      actor: GoalActor,
      goal_id: string,
    ): Promise<{ goal: GoalRecord; steps: GoalStepRecord[]; setup: PinnedAgentSetup }> {
      const { goal, steps } = await loadGoalWithSteps(actor, goal_id);
      if (goal.lifecycle === 'draft') {
        throw new GoalStateError('This goal is still a draft. Activate it before asking for a check.');
      }
      if (goal.lifecycle === 'paused') {
        throw new GoalStateError('This goal is paused. Resume it before asking for a check.');
      }
      if (goal.lifecycle !== 'active') {
        throw new GoalStateError('This goal has finished, so it is no longer checked.');
      }
      if (goal.pinned_setup === null) {
        throw new GoalStateError('This goal was activated without a pinned setup. Activate it again, then check.');
      }
      const current = await resolveSetup(actor, goal);
      if (current.digest !== goal.pinned_setup.digest) {
        throw new GoalSetupChangedError({ goal, current_setup: current });
      }
      return { goal, steps, setup: goal.pinned_setup };
    },

    async listEvidence(
      actor: GoalActor,
      goal_id: string,
      input: { limit: number | undefined; page_token: string | undefined },
    ) {
      await loadGoal(actor, goal_id);
      return store.listEvidence({
        tenant_id: actor.tenant_id,
        created_by: actor.subject_id,
        goal_id,
        limit: input.limit,
        page_token: input.page_token,
      });
    },

    async listEvents(
      actor: GoalActor,
      goal_id: string,
      input: { limit: number | undefined; page_token: string | undefined },
    ) {
      await loadGoal(actor, goal_id);
      return store.listEvents({
        tenant_id: actor.tenant_id,
        created_by: actor.subject_id,
        goal_id,
        limit: input.limit,
        page_token: input.page_token,
      });
    },

    async listWaitingApprovals(
      actor: GoalActor,
      goal_id: string,
      input: { limit: number | undefined; page_token: string | undefined },
    ) {
      await loadGoal(actor, goal_id);
      return store.listWaitingActions({
        tenant_id: actor.tenant_id,
        created_by: actor.subject_id,
        goal_id,
        limit: input.limit,
        page_token: input.page_token,
      });
    },
  };
}

export type GoalService = ReturnType<typeof createGoalService>;

export { GoalRevisionConflictError, GoalSetupResolutionError };
export type { GoalCycleRecord, GoalEvidenceRecord };
