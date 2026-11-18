/**
 * One manual check of a goal (Check now). The host does the observing itself:
 * it reads only the sources the goal selected, records what is new as evidence,
 * links that evidence to the steps those sources speak to, and marks a step
 * verified when its source's new content is the confirmation the step waits for.
 * Steps a finished step unblocks become ready, and the first of them is the
 * next step the goal page shows.
 *
 * Scope is enforced here, by construction: the reader is handed only the goal's
 * selected sources, so a document the agent could reach but the owner did not
 * select is never read into the cycle.
 */
import { nextStepOf, unblockedSteps, type GoalActor, type GoalService } from './goalService';
import type {
  GoalCycleRecord,
  GoalEvidenceRecord,
  GoalRecord,
  GoalSourceRef,
  GoalStepRecord,
  PinnedAgentSetup,
} from './goalStorePort';

/** The longest excerpt of a source kept with its evidence. */
export const GOAL_EVIDENCE_EXCERPT_LIMIT = 500;

/** What reading one selected source produced. Undefined from a reader means the source could not be read. */
export interface GoalSourceRead {
  content: string;
  /** The source's own revision stamp, or a hash of the content when it has none. */
  source_revision: string;
  claimed_event_at: string | null;
}

/** Reads the goal's selected sources through the existing stores and tools. */
export interface GoalSourceReader {
  read(input: { goal: GoalRecord; source: GoalSourceRef }): Promise<GoalSourceRead | undefined>;
}

/**
 * Runs the cycle's session through the existing session machinery with the
 * pinned setup, so the agent can review what the host observed and prepare the
 * next step. Absent, the check still completes on the host's own record.
 */
export interface GoalSessionDispatcher {
  dispatch(input: {
    goal: GoalRecord;
    cycle: GoalCycleRecord;
    setup: PinnedAgentSetup;
    task: string;
  }): Promise<{ session_id: string | null }>;
}

export interface GoalCheckResult {
  cycle: GoalCycleRecord;
  goal: GoalRecord;
  steps: GoalStepRecord[];
  new_evidence: GoalEvidenceRecord[];
  /** Sources the check could not read, named for the goal page's coverage line. */
  unread_sources: GoalSourceRef[];
  next_step: GoalStepRecord | undefined;
}

export async function runManualCheck(input: {
  service: GoalService;
  actor: GoalActor;
  goal_id: string;
  sourceReader: GoalSourceReader;
  sessionDispatcher?: GoalSessionDispatcher | undefined;
  now?: () => Date;
}): Promise<GoalCheckResult> {
  const now = input.now ?? (() => new Date());
  const { service, actor, goal_id } = input;
  const store = service.store;
  const { goal, steps, setup } = await service.loadGoalForCheck(actor, goal_id);

  const startedAt = now();
  const cycle = await store.startCycle({
    tenant_id: actor.tenant_id,
    goal_id,
    input_revision: goal.revision,
    trigger: 'manual',
    started_at: startedAt.toISOString(),
  });
  await store.appendEvent({
    tenant_id: actor.tenant_id,
    goal_id,
    event_type: 'goal_check_started',
    actor: actor.subject_id,
    payload: { cycle_id: cycle.cycle_id, trigger: 'manual', input_revision: goal.revision },
    created_at: startedAt.toISOString(),
  });

  // The newest revision already recorded per source: a source read again at the
  // same revision is not news, and records no second evidence row.
  const { data: priorEvidence } = await store.listEvidence({
    tenant_id: actor.tenant_id,
    goal_id,
    limit: undefined,
    page_token: undefined,
  });
  const latestRevisionByRef = new Map<string, string>();
  for (const evidence of priorEvidence) {
    if (!latestRevisionByRef.has(evidence.source_ref)) {
      latestRevisionByRef.set(evidence.source_ref, evidence.source_revision);
    }
  }

  const newEvidence: GoalEvidenceRecord[] = [];
  const unreadSources: GoalSourceRef[] = [];
  const advancedSteps = new Map<string, GoalStepRecord>();
  let currentSteps = steps;

  for (const source of goal.selected_sources) {
    const read = await input.sourceReader.read({ goal, source });
    if (read === undefined) {
      unreadSources.push(source);
      continue;
    }
    if (latestRevisionByRef.get(source.source_ref) === read.source_revision) {
      continue;
    }
    const evidence = await store.addEvidence({
      tenant_id: actor.tenant_id,
      goal_id,
      cycle_id: cycle.cycle_id,
      source_kind: source.source_kind,
      source_ref: source.source_ref,
      source_revision: read.source_revision,
      observed_at: now().toISOString(),
      claimed_event_at: read.claimed_event_at,
      freshness: 'current',
      admission: 'admitted',
      extraction_method: 'host_read',
      excerpt: read.content.slice(0, GOAL_EVIDENCE_EXCERPT_LIMIT),
    });
    newEvidence.push(evidence);
    latestRevisionByRef.set(source.source_ref, read.source_revision);

    for (const step of currentSteps) {
      if (!step.source_refs.includes(source.source_ref)) {
        continue;
      }
      const evidenceIds = step.evidence_ids.includes(evidence.evidence_id)
        ? step.evidence_ids
        : [...step.evidence_ids, evidence.evidence_id];
      const advance = step.status === 'planned' || step.status === 'ready' || step.status === 'in_progress';
      const updated = await store.updateStep({
        tenant_id: actor.tenant_id,
        goal_id,
        step_id: step.step_id,
        evidence_ids: evidenceIds,
        ...(advance ? { status: 'verified' as const } : {}),
      });
      if (updated !== undefined) {
        advancedSteps.set(updated.step_id, updated);
      }
    }
    currentSteps = await store.listSteps({ tenant_id: actor.tenant_id, goal_id });
  }

  // Steps whose dependencies are now all met become ready; the first is the next step.
  for (const step of unblockedSteps(currentSteps)) {
    await store.updateStep({ tenant_id: actor.tenant_id, goal_id, step_id: step.step_id, status: 'ready' });
  }
  currentSteps = await store.listSteps({ tenant_id: actor.tenant_id, goal_id });
  const nextStep = nextStepOf(currentSteps);

  const changed = newEvidence.length > 0;
  const outcome = changed ? 'completed' : 'nothing_changed';
  const detail = changed
    ? advancedSteps.size > 0
      ? `Recorded ${String(newEvidence.length)} new source${newEvidence.length === 1 ? '' : 's'} and confirmed ${String(advancedSteps.size)} step${advancedSteps.size === 1 ? '' : 's'}.`
      : `Recorded ${String(newEvidence.length)} new source${newEvidence.length === 1 ? '' : 's'}.`
    : 'Nothing new in the selected sources since the last check.';

  let sessionId: string | null = null;
  if (input.sessionDispatcher !== undefined) {
    const task = [
      `Check the goal "${goal.title}".`,
      `Outcome the owner wants: ${goal.outcome}`,
      `This check found: ${detail}`,
      nextStep === undefined
        ? 'No step is ready right now. Say what is blocking the goal, or that it is ready to finish.'
        : `The next step is: ${nextStep.description}`,
      'Review the evidence recorded with the goal, and prepare the next step. Bring anything that needs a decision back as a question for the owner.',
    ].join('\n');
    try {
      const dispatched = await input.sessionDispatcher.dispatch({ goal, cycle, setup, task });
      sessionId = dispatched.session_id;
    } catch {
      // The host's record of the check stands on its own; a session that failed
      // to start is noted on the goal's history, not hidden and not fatal.
      await store.appendEvent({
        tenant_id: actor.tenant_id,
        goal_id,
        event_type: 'goal_check_session_failed',
        actor: actor.subject_id,
        payload: { cycle_id: cycle.cycle_id },
        created_at: now().toISOString(),
      });
    }
  }

  const finishedAt = now();
  const nextCheckAt = new Date(finishedAt.getTime() + (24 * 60 * 60 * 1000) / goal.execution_policy.checks_per_day);
  const finished = await store.finishCycle({
    tenant_id: actor.tenant_id,
    goal_id,
    cycle_id: cycle.cycle_id,
    finished_at: finishedAt.toISOString(),
    outcome,
    outcome_detail: detail,
    session_id: sessionId,
    next_check_at: nextCheckAt.toISOString(),
  });
  await store.updateGoal({
    tenant_id: actor.tenant_id,
    goal_id,
    expected_revision: goal.revision,
    patch: { next_check_at: nextCheckAt.toISOString() },
  });
  await store.appendEvent({
    tenant_id: actor.tenant_id,
    goal_id,
    event_type: 'goal_check_finished',
    actor: actor.subject_id,
    payload: {
      cycle_id: cycle.cycle_id,
      outcome,
      new_evidence: newEvidence.map(evidence => evidence.evidence_id),
      next_step_id: nextStep?.step_id ?? null,
      unread_sources: unreadSources.map(source => source.source_ref),
    },
    created_at: finishedAt.toISOString(),
  });

  const finalGoal = (await store.getGoal({ tenant_id: actor.tenant_id, goal_id })) ?? goal;
  return {
    cycle: finished ?? cycle,
    goal: finalGoal,
    steps: currentSteps,
    new_evidence: newEvidence,
    unread_sources: unreadSources,
    next_step: nextStep,
  };
}
