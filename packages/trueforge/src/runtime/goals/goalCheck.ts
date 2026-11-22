/**
 * One manual check of a goal (Check now). The host does the observing itself:
 * it reads only the sources the goal selected, records what is new as evidence,
 * and links that evidence to the steps those sources speak to. Recording is
 * all the host does to a step. It never marks a step verified, because judging
 * whether a source's content meets a step's acceptance criteria is later work.
 * Until then a step is confirmed by the owner alone. Steps a confirmed step
 * unblocks become ready, and the first of them is the next step the goal page
 * shows.
 *
 * A check runs no session in this layer. Session dispatch returns with the
 * work that judges content, under the goal's selected scope.
 *
 * Scope is enforced here, by construction: the reader is handed only the goal's
 * selected sources, so a document the agent could reach but the owner did not
 * select is never read into the cycle.
 */
import { nextStepOf, unblockedSteps, type GoalActor, type GoalService } from './goalService';
import type { GoalCycleRecord, GoalEvidenceRecord, GoalRecord, GoalSourceRef, GoalStepRecord } from './goalStorePort';

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
  now?: () => Date;
}): Promise<GoalCheckResult> {
  const now = input.now ?? (() => new Date());
  const { service, actor, goal_id } = input;
  const store = service.store;
  const { goal, steps } = await service.loadGoalForCheck(actor, goal_id);

  const startedAt = now();
  const cycle = await store.startCycle({
    tenant_id: actor.tenant_id,
    created_by: actor.subject_id,
    goal_id,
    input_revision: goal.revision,
    trigger: 'manual',
    started_at: startedAt.toISOString(),
  });
  await store.appendEvent({
    tenant_id: actor.tenant_id,
    created_by: actor.subject_id,
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
    created_by: actor.subject_id,
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
      created_by: actor.subject_id,
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

    // The evidence is linked to every step the source speaks to, and that is
    // all the host does to those steps: no status changes here, whatever the
    // content says and whatever the step was waiting on.
    for (const step of currentSteps) {
      if (!step.source_refs.includes(source.source_ref)) {
        continue;
      }
      const evidenceIds = step.evidence_ids.includes(evidence.evidence_id)
        ? step.evidence_ids
        : [...step.evidence_ids, evidence.evidence_id];
      await store.updateStep({
        tenant_id: actor.tenant_id,
        created_by: actor.subject_id,
        goal_id,
        step_id: step.step_id,
        evidence_ids: evidenceIds,
      });
    }
    currentSteps = await store.listSteps({ tenant_id: actor.tenant_id, created_by: actor.subject_id, goal_id });
  }

  // Steps whose dependencies are now all met become ready; the first is the next step.
  for (const step of unblockedSteps(currentSteps)) {
    await store.updateStep({
      tenant_id: actor.tenant_id,
      created_by: actor.subject_id,
      goal_id,
      step_id: step.step_id,
      status: 'ready',
    });
  }
  currentSteps = await store.listSteps({ tenant_id: actor.tenant_id, created_by: actor.subject_id, goal_id });
  const nextStep = nextStepOf(currentSteps);

  const changed = newEvidence.length > 0;
  const outcome = changed ? 'completed' : 'nothing_changed';
  const detail = changed
    ? `Recorded ${String(newEvidence.length)} new source${newEvidence.length === 1 ? '' : 's'}.`
    : 'Nothing new in the selected sources since the last check.';

  const finishedAt = now();
  const nextCheckAt = new Date(finishedAt.getTime() + (24 * 60 * 60 * 1000) / goal.execution_policy.checks_per_day);
  const finished = await store.finishCycle({
    tenant_id: actor.tenant_id,
    created_by: actor.subject_id,
    goal_id,
    cycle_id: cycle.cycle_id,
    finished_at: finishedAt.toISOString(),
    outcome,
    outcome_detail: detail,
    session_id: null,
    next_check_at: nextCheckAt.toISOString(),
  });
  await store.updateGoal({
    tenant_id: actor.tenant_id,
    created_by: actor.subject_id,
    goal_id,
    expected_revision: goal.revision,
    patch: { next_check_at: nextCheckAt.toISOString() },
  });
  await store.appendEvent({
    tenant_id: actor.tenant_id,
    created_by: actor.subject_id,
    goal_id,
    event_type: 'goal_check_finished',
    actor: actor.subject_id,
    payload: {
      cycle_id: cycle.cycle_id,
      outcome,
      new_evidence: newEvidence.map(evidence => evidence.evidence_id),
      // The evidence rows themselves carry no excerpt or cycle link in the
      // canonical store, so the excerpts ride here, keyed by evidence id, and
      // the store adapter joins them back onto the rows it reads out.
      evidence_excerpts: Object.fromEntries(newEvidence.map(evidence => [evidence.evidence_id, evidence.excerpt])),
      next_step_id: nextStep?.step_id ?? null,
      unread_sources: unreadSources.map(source => source.source_ref),
    },
    created_at: finishedAt.toISOString(),
  });

  const finalGoal =
    (await store.getGoal({ tenant_id: actor.tenant_id, created_by: actor.subject_id, goal_id })) ?? goal;
  return {
    cycle: finished ?? cycle,
    goal: finalGoal,
    steps: currentSteps,
    new_evidence: newEvidence,
    unread_sources: unreadSources,
    next_step: nextStep,
  };
}
