import type {
  GoalApproval,
  GoalCycleOutcome,
  GoalEvent,
  GoalItem,
  GoalLifecycle,
  GoalSourceKind,
  GoalStep,
  GoalStepStatus,
} from './types.js';

/** What an active goal needs next, derived by the host-side record, never guessed by a model. */
export type GoalAttentionState =
  'working' | 'waiting_for_you' | 'waiting_for_a_source' | 'blocked' | 'work_limit_reached' | 'ready_to_finish';

/** The newest finished check on a goal, read from its history. */
export type GoalLastCheck = {
  finishedAt: string;
  outcome: GoalCycleOutcome;
  /** Source references the check could not read. */
  unreadSourceRefs: string[];
  newEvidenceCount: number;
};

const CYCLE_OUTCOMES: readonly GoalCycleOutcome[] = [
  'completed',
  'nothing_changed',
  'needs_decision',
  'budget_exhausted',
  'failed',
];

function isGoalCycleOutcome(value: string): value is GoalCycleOutcome {
  return CYCLE_OUTCOMES.some(outcome => outcome === value);
}

function payloadString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function payloadStringList(payload: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** The newest finished check in a goal's events, or null when no check has finished yet. */
export function lastCheckFromEvents(events: readonly GoalEvent[]): GoalLastCheck | null {
  let latest: GoalLastCheck | null = null;
  for (const event of events) {
    if (event.eventType !== 'goal_check_finished') continue;
    if (latest !== null && event.createdAt < latest.finishedAt) continue;
    const outcome = payloadString(event.payload, 'outcome');
    if (outcome === null || !isGoalCycleOutcome(outcome)) continue;
    latest = {
      finishedAt: event.createdAt,
      outcome,
      unreadSourceRefs: payloadStringList(event.payload, 'unread_sources'),
      newEvidenceCount: payloadStringList(event.payload, 'new_evidence').length,
    };
  }
  return latest;
}

function isFinishedStep(step: GoalStep): boolean {
  return step.status === 'verified' || step.status === 'owner_confirmed';
}

/**
 * The attention state of an active goal, with the reason in plain words. The
 * order is deliberate: a stopped check and a waiting decision outrank the
 * ordinary run of work, and a stall outranks a source that would not read.
 */
export function deriveGoalAttention(input: {
  goal: GoalItem;
  steps: readonly GoalStep[];
  nextStepId: string | null;
  approvals: readonly GoalApproval[];
  lastCheck: GoalLastCheck | null;
}): { state: GoalAttentionState; reason: string } | null {
  const { goal, steps, approvals, lastCheck } = input;
  if (goal.lifecycle !== 'active') return null;

  if (lastCheck?.outcome === 'budget_exhausted') {
    return {
      state: 'work_limit_reached',
      reason:
        goal.nextCheckAt !== null
          ? `The last check used up its work limit. Work can resume at the next check, due ${formatGoalDateTime(goal.nextCheckAt, goal.timezone)}.`
          : 'The last check used up its work limit.',
    };
  }

  const waitingStep = steps.find(step => step.status === 'waiting_for_approval');
  if (approvals.length > 0 || waitingStep !== undefined) {
    return {
      state: 'waiting_for_you',
      reason:
        approvals.length > 1
          ? `${String(approvals.length)} decisions are waiting for you below.`
          : 'A decision is waiting for you below.',
    };
  }

  const failedStep = steps.find(step => step.status === 'failed');
  if (failedStep !== undefined) {
    return { state: 'blocked', reason: `The step “${failedStep.description}” failed.` };
  }
  const unknownStep = steps.find(step => step.status === 'outcome_unknown');
  if (unknownStep !== undefined) {
    return {
      state: 'blocked',
      reason: `What happened on the step “${unknownStep.description}” is not known yet.`,
    };
  }

  if (steps.length > 0 && steps.every(isFinishedStep)) {
    return { state: 'ready_to_finish', reason: 'Every step has its evidence or your confirmation.' };
  }

  if (lastCheck !== null && lastCheck.unreadSourceRefs.length > 0) {
    const names = lastCheck.unreadSourceRefs.map(
      ref => goal.selectedSources.find(source => source.sourceRef === ref)?.label ?? ref,
    );
    return {
      state: 'waiting_for_a_source',
      reason: `The last check could not read ${names.join(', ')}.`,
    };
  }

  const nextStep = steps.find(step => step.stepId === input.nextStepId) ?? nextStepOf(steps);
  if (nextStep !== null) {
    return { state: 'working', reason: `Next step: ${nextStep.description}` };
  }
  if (steps.some(step => !isFinishedStep(step))) {
    return { state: 'blocked', reason: 'No step can move yet. Look at what its steps are waiting on.' };
  }
  return { state: 'working', reason: 'Checks are running as planned.' };
}

/** The step work turns to next in a step list: the first ready or running step whose dependencies are finished. */
export function nextStepOf(steps: readonly GoalStep[]): GoalStep | null {
  const finished = new Set(steps.filter(isFinishedStep).map(step => step.stepId));
  return (
    steps.find(
      step =>
        (step.status === 'ready' || step.status === 'in_progress') &&
        step.dependsOn.every(dependency => finished.has(dependency)),
    ) ?? null
  );
}

const ATTENTION_LABELS: Record<GoalAttentionState, string> = {
  working: 'Working',
  waiting_for_you: 'Waiting for you',
  waiting_for_a_source: 'Waiting for a source',
  blocked: 'Blocked',
  work_limit_reached: 'Work limit reached',
  ready_to_finish: 'Ready to finish',
};

const LIFECYCLE_LABELS: Record<GoalLifecycle, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  ended: 'Ended',
};

/** The one status line a goal shows everywhere: a short label and, when there is one, the reason. */
export type GoalStatusSummary = { label: string; reason: string | null };

export function goalStatusSummary(input: {
  goal: GoalItem;
  steps: readonly GoalStep[];
  nextStepId: string | null;
  approvals: readonly GoalApproval[];
  lastCheck: GoalLastCheck | null;
}): GoalStatusSummary {
  const { goal } = input;
  if (goal.lifecycle === 'draft') {
    return { label: 'Draft', reason: 'Not started yet. Review the card and activate it when you are ready.' };
  }
  if (goal.lifecycle === 'paused') {
    return { label: 'Paused', reason: 'Checks are stopped until you resume this goal.' };
  }
  if (goal.lifecycle === 'completed') return { label: 'Completed', reason: null };
  if (goal.lifecycle === 'ended') return { label: 'Ended', reason: null };
  const attention = deriveGoalAttention({
    goal,
    steps: input.steps,
    nextStepId: input.nextStepId,
    approvals: input.approvals,
    lastCheck: input.lastCheck,
  });
  if (attention === null) return { label: LIFECYCLE_LABELS[goal.lifecycle], reason: null };
  return { label: ATTENTION_LABELS[attention.state], reason: attention.reason };
}

/** Steps with their evidence or the owner's confirmation, out of all steps. Counts only, never a percentage. */
export function goalProgressCounts(steps: readonly GoalStep[]): { confirmed: number; total: number } {
  return { confirmed: steps.filter(isFinishedStep).length, total: steps.length };
}

const STEP_STATUS_LABELS: Record<GoalStepStatus, string> = {
  planned: 'Planned',
  ready: 'Ready',
  in_progress: 'In progress',
  waiting_for_approval: 'Waiting for approval',
  awaiting_verification: 'Awaiting verification',
  verified: 'Verified',
  owner_confirmed: 'Confirmed by you',
  failed: 'Failed',
  outcome_unknown: 'Outcome unknown',
};

export function goalStepStatusLabel(status: GoalStepStatus): string {
  return STEP_STATUS_LABELS[status];
}

const SOURCE_KIND_LABELS: Record<GoalSourceKind, string> = {
  space: 'Space',
  document: 'Document',
  mail: 'Mail',
  calendar: 'Calendar',
  web: 'Web page',
  manual: 'Added by hand',
};

export function goalSourceKindLabel(kind: GoalSourceKind): string {
  return SOURCE_KIND_LABELS[kind];
}

/** One history entry in plain words, for the What changed timeline. */
export function goalEventLine(event: GoalEvent): string {
  switch (event.eventType) {
    case 'goal_created':
      return 'Goal created.';
    case 'goal_updated':
      return 'The goal was edited.';
    case 'goal_activated':
      return 'The goal was activated.';
    case 'goal_setup_confirmed':
      return 'An updated agent setup was confirmed.';
    case 'goal_paused':
      return 'The goal was paused.';
    case 'goal_resumed':
      return 'The goal was resumed.';
    case 'goal_ended':
      return 'The goal was ended.';
    case 'goal_check_started':
      return 'A check started.';
    case 'goal_check_session_failed':
      return 'A check could not start its work session. The check itself is still recorded.';
    case 'goal_check_finished': {
      const outcome = payloadString(event.payload, 'outcome');
      const evidenceCount = payloadStringList(event.payload, 'new_evidence').length;
      switch (outcome) {
        case 'nothing_changed':
          return 'A check finished. Nothing had changed.';
        case 'needs_decision':
          return 'A check finished. A decision is waiting for you.';
        case 'budget_exhausted':
          return 'A check stopped early. The work limit was reached.';
        case 'failed':
          return 'A check failed.';
        default:
          return evidenceCount > 0
            ? `A check finished and recorded ${String(evidenceCount)} new ${evidenceCount === 1 ? 'piece' : 'pieces'} of evidence.`
            : 'A check finished.';
      }
    }
    default:
      return 'Something changed on this goal.';
  }
}

/** A date and time read in the goal's own time zone, such as "June 15, 2026, 9:00 AM". */
export function formatGoalDateTime(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
  }
}

/** A date read in the goal's own time zone, such as "June 15, 2026". */
export function formatGoalDate(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
  }
}
