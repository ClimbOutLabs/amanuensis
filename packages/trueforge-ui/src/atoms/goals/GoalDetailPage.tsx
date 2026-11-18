'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { openDeliveryLink } from '../../deliveries/openDelivery.js';
import {
  formatGoalDateTime,
  goalEventLine,
  goalProgressCounts,
  goalSourceKindLabel,
  goalStatusSummary,
  goalStepStatusLabel,
  lastCheckFromEvents,
  type GoalLastCheck,
} from '../../goals/goalAttention.js';
import { useGoals } from '../../goals/GoalsContext.js';
import {
  GoalSetupChangedError,
  type GoalActivationPreview,
  type GoalApproval,
  type GoalCheckResult,
  type GoalDetail,
  type GoalEvent,
  type GoalEvidence,
  type GoalStep,
} from '../../goals/types.js';
import { useOptionalServer } from '../../server/ServerContext.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../primitives/Dialog.js';
import { Skeleton } from '../primitives/Skeleton.js';
import { GoalActivationCard } from './GoalActivationCard.js';
import { GoalEditDialog } from './GoalEditDialog.js';

const PILL_CLASS = 'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem] leading-4 font-medium';

function SectionTitle({ children }: { children: string }) {
  return <h2 className="px-1 text-xs font-semibold tracking-wide text-text-secondary uppercase">{children}</h2>;
}

function StepRow({
  step,
  steps,
  evidenceById,
  isNext,
  timezone,
}: {
  step: GoalStep;
  steps: readonly GoalStep[];
  evidenceById: ReadonlyMap<string, GoalEvidence>;
  isNext: boolean;
  timezone: string;
}) {
  const evidence = step.evidenceIds
    .map(id => evidenceById.get(id))
    .filter((entry): entry is GoalEvidence => entry !== undefined);
  const waitingOn = step.dependsOn
    .map(id => steps.find(candidate => candidate.stepId === id)?.description)
    .filter((description): description is string => description !== undefined);
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm leading-5 font-medium break-words text-text-primary">{step.description}</span>
        <span
          className={cn(
            PILL_CLASS,
            step.status === 'failed'
              ? 'bg-failure-bg/10 text-failure-bg'
              : step.status === 'verified' || step.status === 'owner_confirmed'
                ? 'bg-secondary-bg text-text-primary'
                : 'bg-primary-bg text-text-secondary',
          )}
        >
          {goalStepStatusLabel(step.status)}
        </span>
        {isNext ? <span className={cn(PILL_CLASS, 'bg-gold/30 text-text-primary')}>Next step</span> : null}
      </span>
      {waitingOn.length > 0 ? (
        <span className="text-xs leading-5 text-text-secondary">After {waitingOn.join(', ')}</span>
      ) : null}
      {step.acceptanceCriteria !== '' ? (
        <span className="text-xs leading-5 text-text-secondary">Done when: {step.acceptanceCriteria}</span>
      ) : null}
      {evidence.map(entry => (
        <span key={entry.evidenceId} className="rounded-lg bg-primary-bg px-3 py-2 text-xs leading-5 text-text-primary">
          {entry.excerpt}
          <span className="block text-text-secondary">Seen {formatGoalDateTime(entry.observedAt, timezone)}</span>
        </span>
      ))}
    </li>
  );
}

function DecisionRow({
  approval,
  timezone,
  sessionId,
  onOpenChat,
}: {
  approval: GoalApproval;
  timezone: string;
  sessionId: string | null;
  onOpenChat: (sessionId: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-5 font-medium text-text-primary">A decision is waiting for you</span>
        <span className="block text-xs leading-5 text-text-secondary">
          Waiting since {formatGoalDateTime(approval.createdAt, timezone)}.
        </span>
      </span>
      {sessionId !== null ? (
        <Button.Secondary type="button" onClick={() => onOpenChat(sessionId)}>
          Open the chat
        </Button.Secondary>
      ) : (
        <span className="text-xs text-text-secondary">Answer it in the chat where it was asked.</span>
      )}
    </li>
  );
}

function checkOutcomeLine(result: GoalCheckResult, timezone: string): string {
  const { cycle, newEvidence, unreadSources } = result;
  const evidenceLine =
    newEvidence.length > 0
      ? ` It recorded ${String(newEvidence.length)} new ${newEvidence.length === 1 ? 'piece' : 'pieces'} of evidence.`
      : '';
  const unreadLine =
    unreadSources.length > 0 ? ` It could not read ${unreadSources.map(source => source.label).join(', ')}.` : '';
  switch (cycle.outcome) {
    case 'nothing_changed':
      return `Check finished. Nothing had changed.${unreadLine}`;
    case 'needs_decision':
      return `Check finished. A decision is waiting for you below.${evidenceLine}${unreadLine}`;
    case 'budget_exhausted':
      return `Check stopped early. The work limit was reached.${evidenceLine}${unreadLine}`;
    case 'failed':
      return `That check failed. ${cycle.outcomeDetail ?? 'Try again in a moment.'}`;
    default:
      return `Check finished at ${formatGoalDateTime(cycle.finishedAt ?? cycle.startedAt, timezone)}.${evidenceLine}${unreadLine}`;
  }
}

/**
 * One goal: its plan, the evidence under each step, the decisions waiting, what
 * changed, and the controls. A draft shows its activation card instead of the
 * running view, and a goal whose agent setup changed shows the updated card
 * until the owner confirms it.
 */
export function GoalDetailPage({ goalId }: { goalId: string }) {
  const { api } = useGoals();
  const shell = useOptionalShellMode();
  const server = useOptionalServer();
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [evidence, setEvidence] = useState<GoalEvidence[]>([]);
  const [events, setEvents] = useState<GoalEvent[]>([]);
  const [approvals, setApprovals] = useState<GoalApproval[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [preview, setPreview] = useState<GoalActivationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [setupChanged, setSetupChanged] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkLine, setCheckLine] = useState<string | null>(null);
  const [checkLimitDetail, setCheckLimitDetail] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [sessionByCycle, setSessionByCycle] = useState<ReadonlyMap<string, string>>(new Map());
  const [openError, setOpenError] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey(key => key + 1), []);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    Promise.all([
      api.getGoal(goalId),
      api.listEvidence(goalId),
      api.listEvents(goalId),
      api.listApprovals(goalId),
    ]).then(
      ([nextDetail, nextEvidence, nextEvents, nextApprovals]) => {
        if (!alive) return;
        setDetail(nextDetail);
        setEvidence(nextEvidence);
        setEvents(nextEvents);
        setApprovals(nextApprovals);
      },
      () => {
        if (alive) setLoadError('This goal could not be loaded. Check your connection, then try again.');
      },
    );
    return () => {
      alive = false;
    };
  }, [api, goalId, reloadKey]);

  const needsCard = detail !== null && (detail.goal.lifecycle === 'draft' || preview !== null);
  useEffect(() => {
    if (detail === null || detail.goal.lifecycle !== 'draft' || preview !== null) return;
    let alive = true;
    setPreviewError(null);
    api.getActivationPreview(goalId).then(
      next => {
        if (alive) setPreview(next);
      },
      (error: unknown) => {
        if (alive) {
          setPreviewError(
            error instanceof Error && error.message !== ''
              ? error.message
              : 'The activation card could not be prepared. Try again in a moment.',
          );
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [api, goalId, detail, preview]);

  const lastCheck: GoalLastCheck | null = useMemo(() => lastCheckFromEvents(events), [events]);
  const evidenceById = useMemo(() => new Map(evidence.map(entry => [entry.evidenceId, entry])), [evidence]);
  const summary = useMemo(
    () =>
      detail === null
        ? null
        : goalStatusSummary({
            goal: detail.goal,
            steps: detail.steps,
            nextStepId: detail.nextStepId,
            approvals,
            lastCheck,
          }),
    [detail, approvals, lastCheck],
  );

  const runAction = useCallback(
    (action: () => Promise<GoalDetail>) => {
      setActing(true);
      setActionError(null);
      action().then(
        next => {
          setActing(false);
          setDetail(next);
          reload();
        },
        () => {
          setActing(false);
          setActionError('That did not work. The goal may have changed since it was read. The page has been reloaded.');
          reload();
        },
      );
    },
    [reload],
  );

  const runCheck = useCallback(() => {
    setChecking(true);
    setCheckLine(null);
    setActionError(null);
    api.checkGoal(goalId).then(
      result => {
        setChecking(false);
        setCheckLine(checkOutcomeLine(result, result.goal.timezone));
        setCheckLimitDetail(result.cycle.outcome === 'budget_exhausted' ? result.cycle.outcomeDetail : null);
        if (result.cycle.sessionId !== null) {
          setSessionByCycle(current => new Map(current).set(result.cycle.cycleId, result.cycle.sessionId ?? ''));
        }
        setDetail({ goal: result.goal, steps: result.steps, nextStepId: result.nextStepId });
        reload();
      },
      (error: unknown) => {
        setChecking(false);
        if (error instanceof GoalSetupChangedError) {
          setPreview(error.preview);
          setSetupChanged(true);
          setActivateError(null);
        } else {
          setActionError('That check could not run. Try again in a moment.');
        }
      },
    );
  }, [api, goalId, reload]);

  const activate = useCallback(
    (input: {
      executionPolicy: GoalActivationPreview['goal']['executionPolicy'];
      notificationPolicy: GoalActivationPreview['goal']['notificationPolicy'];
    }) => {
      if (preview === null || detail === null) return;
      setActivating(true);
      setActivateError(null);
      const policyChanged =
        JSON.stringify(input.executionPolicy) !== JSON.stringify(preview.goal.executionPolicy) ||
        JSON.stringify(input.notificationPolicy) !== JSON.stringify(preview.goal.notificationPolicy);
      const ready: Promise<GoalDetail> = policyChanged
        ? api.updateGoal(goalId, {
            expectedRevision: preview.goal.revision,
            executionPolicy: input.executionPolicy,
            notificationPolicy: input.notificationPolicy,
          })
        : Promise.resolve(detail);
      ready
        .then(
          current =>
            api.activateGoal(goalId, {
              expectedRevision: current.goal.revision,
              setupDigest: preview.setup.digest,
            }),
          (error: unknown) => Promise.reject(error instanceof Error ? error : new Error('update failed')),
        )
        .then(
          next => {
            setActivating(false);
            setPreview(null);
            setSetupChanged(false);
            setDetail(next);
            reload();
          },
          (error: unknown) => {
            setActivating(false);
            if (error instanceof GoalSetupChangedError) {
              setPreview(error.preview);
              setSetupChanged(true);
            } else {
              setActivateError('That goal could not be activated. The page has been reloaded, then try again.');
              reload();
            }
          },
        );
    },
    [api, goalId, preview, detail, reload],
  );

  const openChat = useCallback(
    (sessionId: string) => {
      if (shell === null) return;
      void openDeliveryLink({ shell, server, link: { type: 'chat', sessionId } }).then(outcome => {
        setOpenError(outcome.opened ? null : outcome.message);
      });
    },
    [shell, server],
  );

  if (loadError !== null) {
    return (
      <div className="flex flex-col items-center gap-3 px-3 py-8 text-center" role="alert">
        <p className="text-sm text-failure-bg">{loadError}</p>
        <Button.Secondary type="button" onClick={reload}>
          Try again
        </Button.Secondary>
      </div>
    );
  }
  if (detail === null || summary === null) {
    return (
      <div className="flex flex-col gap-2 px-4 py-4" role="status" aria-label="Loading goal">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const { goal, steps } = detail;
  const counts = goalProgressCounts(steps);
  const nextStep = steps.find(step => step.stepId === detail.nextStepId) ?? null;
  const lastSuccessfulCheck = [...events]
    .reverse()
    .find(
      event =>
        event.eventType === 'goal_check_finished' &&
        (event.payload['outcome'] === 'completed' || event.payload['outcome'] === 'nothing_changed'),
    );
  const unreadLabels =
    lastCheck === null
      ? []
      : lastCheck.unreadSourceRefs.map(
          ref => goal.selectedSources.find(source => source.sourceRef === ref)?.label ?? ref,
        );
  const limitReached = lastCheck?.outcome === 'budget_exhausted' || checkLimitDetail !== null;
  const timeline = [...events].reverse();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-4">
      <div className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-lg font-semibold text-text-primary">{goal.title}</h2>
          <span className={cn(PILL_CLASS, 'bg-primary-bg text-text-secondary')}>{summary.label}</span>
        </span>
        <p className="text-sm leading-6 text-text-primary">{goal.outcome}</p>
        {summary.reason !== null ? <p className="text-sm text-text-secondary">{summary.reason}</p> : null}
        <p className="text-xs text-text-secondary">
          {goal.targetAt !== null
            ? `Target: ${formatGoalDateTime(goal.targetAt, goal.timezone)} (${goal.timezone}). `
            : ''}
          {counts.total > 0
            ? `${String(counts.confirmed)} of ${String(counts.total)} steps confirmed.`
            : 'No steps yet.'}
        </p>
        {goal.linkedSpaceId !== null ? (
          <p className="text-xs text-text-secondary">
            This goal has a linked Space, which is a view of the plan only.{' '}
            <button
              type="button"
              className="font-medium text-text-primary underline underline-offset-2"
              onClick={() => shell?.openSpaces(goal.linkedSpaceId)}
            >
              Open the Space
            </button>
          </p>
        ) : null}
      </div>

      {openError !== null ? (
        <p role="alert" className="text-sm text-failure-bg">
          {openError}
        </p>
      ) : null}
      {actionError !== null ? (
        <p role="alert" className="text-sm text-failure-bg">
          {actionError}
        </p>
      ) : null}
      {checkLine !== null ? (
        <p role="status" className="rounded-lg bg-primary-bg px-3 py-2 text-sm text-text-primary">
          {checkLine}
        </p>
      ) : null}

      {goal.lifecycle !== 'completed' && goal.lifecycle !== 'ended' ? (
        <div className="flex flex-wrap gap-2">
          {goal.lifecycle === 'active' ? (
            <Button.Primary type="button" disabled={checking} onClick={runCheck}>
              {checking ? 'Checking…' : 'Check now'}
            </Button.Primary>
          ) : null}
          <Button.Secondary type="button" onClick={() => setEditOpen(true)}>
            Edit
          </Button.Secondary>
          {goal.lifecycle === 'active' ? (
            <Button.Secondary
              type="button"
              disabled={acting}
              onClick={() => runAction(() => api.pauseGoal(goalId, goal.revision))}
            >
              Pause
            </Button.Secondary>
          ) : null}
          {goal.lifecycle === 'paused' ? (
            <Button.Secondary
              type="button"
              disabled={acting}
              onClick={() => runAction(() => api.resumeGoal(goalId, goal.revision))}
            >
              Resume
            </Button.Secondary>
          ) : null}
          <Button.Secondary type="button" onClick={() => setEndOpen(true)}>
            End goal
          </Button.Secondary>
        </div>
      ) : null}

      {needsCard && preview !== null ? (
        <GoalActivationCard
          preview={preview}
          setupChanged={setupChanged}
          busy={activating}
          error={activateError}
          onActivate={activate}
        />
      ) : needsCard && previewError !== null ? (
        <p role="alert" className="rounded-xl border border-border bg-card-bg px-4 py-3 text-sm text-failure-bg">
          {previewError}
        </p>
      ) : null}

      {limitReached && goal.lifecycle === 'active' ? (
        <section
          aria-label="Work limit reached"
          className="flex flex-col gap-1 rounded-xl border border-border bg-card-bg px-4 py-3"
        >
          <h2 className="text-sm font-semibold text-text-primary">Work limit reached</h2>
          <p className="text-sm text-text-primary">
            {checkLimitDetail ?? 'The last check stopped when it reached one of its work limits.'}
          </p>
          <p className="text-sm text-text-secondary">
            {nextStep !== null ? `The next step is saved: ${nextStep.description}. ` : ''}
            {goal.nextCheckAt !== null
              ? `Work can resume at the next check, due ${formatGoalDateTime(goal.nextCheckAt, goal.timezone)}.`
              : ''}
          </p>
        </section>
      ) : null}

      {approvals.length > 0 ? (
        <section aria-label="Needs your decision" className="flex flex-col gap-2">
          <SectionTitle>Needs your decision</SectionTitle>
          <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-card-bg">
            {approvals.map(approval => (
              <DecisionRow
                key={approval.actionId}
                approval={approval}
                timezone={goal.timezone}
                sessionId={approval.cycleId !== null ? (sessionByCycle.get(approval.cycleId) ?? null) : null}
                onOpenChat={openChat}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Plan" className="flex flex-col gap-2">
        <SectionTitle>Plan</SectionTitle>
        {steps.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-text-secondary">
            No steps yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card-bg">
            {steps.map(step => (
              <StepRow
                key={step.stepId}
                step={step}
                steps={steps}
                evidenceById={evidenceById}
                isNext={step.stepId === detail.nextStepId}
                timezone={goal.timezone}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Checks and work" className="flex flex-col gap-2">
        <SectionTitle>Checks and work</SectionTitle>
        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card-bg px-4 py-3 text-sm leading-6 text-text-primary">
          <p>
            Last successful check:{' '}
            {lastSuccessfulCheck !== undefined
              ? formatGoalDateTime(lastSuccessfulCheck.createdAt, goal.timezone)
              : 'none yet'}
            .
          </p>
          <p>
            Next check:{' '}
            {goal.lifecycle === 'active' && goal.nextCheckAt !== null
              ? formatGoalDateTime(goal.nextCheckAt, goal.timezone)
              : 'none scheduled'}
            .
          </p>
          <p>
            {lastCheck === null
              ? 'No check has run yet, so there are no coverage gaps to report.'
              : unreadLabels.length > 0
                ? `Coverage gaps: the last check could not read ${unreadLabels.join(', ')}.`
                : 'The last check read every selected source.'}
          </p>
          <p className="text-text-secondary">
            This goal is checked{' '}
            {goal.executionPolicy.checksPerDay === 1
              ? 'once a day'
              : `${String(goal.executionPolicy.checksPerDay)} times a day`}
            . One check may work for up to about {String(goal.executionPolicy.cycleMinutes)} minutes and use at most{' '}
            {goal.executionPolicy.dailyTokenAllowance.toLocaleString('en-US')} tokens a day across all checks.
          </p>
          {goal.selectedSources.length > 0 ? (
            <p className="text-text-secondary">
              Sources:{' '}
              {goal.selectedSources
                .map(source => `${source.label} (${goalSourceKindLabel(source.sourceKind).toLowerCase()})`)
                .join(', ')}
              .
            </p>
          ) : null}
        </div>
      </section>

      <section aria-label="What changed" className="flex flex-col gap-2">
        <SectionTitle>What changed</SectionTitle>
        {timeline.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-text-secondary">
            Nothing yet. Changes will show here as the goal is worked on.
          </p>
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-card-bg">
            {timeline.map(event => (
              <li key={event.eventId} className="flex flex-col px-4 py-2.5">
                <span className="text-sm leading-5 text-text-primary">{goalEventLine(event)}</span>
                <span className="text-xs leading-5 text-text-secondary">
                  {formatGoalDateTime(event.createdAt, goal.timezone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editOpen ? (
        <GoalEditDialog
          detail={detail}
          onClose={() => setEditOpen(false)}
          onSaved={next => {
            setDetail(next);
            setEditOpen(false);
            reload();
          }}
        />
      ) : null}

      {endOpen ? (
        <Dialog
          open
          onOpenChange={next => {
            if (!next) setEndOpen(false);
          }}
          aria-label="End goal"
          className="max-w-md"
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>End this goal</DialogTitle>
              <p className="text-sm text-text-secondary">
                “{goal.title}” will stop being checked, and its waiting decisions will be cleared. Its history stays
                here for reference. This cannot be undone.
              </p>
            </DialogHeader>
          </DialogContent>
          <DialogFooter>
            <Button.Secondary type="button" onClick={() => setEndOpen(false)}>
              Cancel
            </Button.Secondary>
            <Button.Destructive
              type="button"
              disabled={acting}
              onClick={() => {
                setEndOpen(false);
                runAction(() => api.endGoal(goalId, goal.revision));
              }}
            >
              End goal
            </Button.Destructive>
          </DialogFooter>
        </Dialog>
      ) : null}
    </div>
  );
}
