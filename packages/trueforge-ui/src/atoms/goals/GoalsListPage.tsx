'use client';

import { useEffect, useState } from 'react';

import {
  formatGoalDate,
  formatGoalTarget,
  goalStatusSummary,
  lastCheckFromEvents,
  type GoalStatusSummary,
} from '../../goals/goalAttention.js';
import { useGoals } from '../../goals/GoalsContext.js';
import type { GoalItem } from '../../goals/types.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { Skeleton } from '../primitives/Skeleton.js';
import { GoalCreateDialog } from './GoalCreateDialog.js';

type GoalRow = { goal: GoalItem; summary: GoalStatusSummary };

/**
 * The Goals page: every goal with where it stands and why. For a running goal
 * the status is worked out from its plan, its waiting decisions, and its last
 * check; a goal whose detail cannot be read still lists, with its lifecycle
 * alone as the status.
 */
export function GoalsListPage() {
  const { api } = useGoals();
  const shell = useOptionalShellMode();
  const [rows, setRows] = useState<GoalRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    api.listGoals().then(
      async goals => {
        const summaries = await Promise.all(
          goals.map(async (goal): Promise<GoalRow> => {
            if (goal.lifecycle !== 'active') {
              return {
                goal,
                summary: goalStatusSummary({ goal, steps: [], nextStepId: null, approvals: [], lastCheck: null }),
              };
            }
            try {
              const [detail, approvals, events] = await Promise.all([
                api.getGoal(goal.goalId),
                api.listApprovals(goal.goalId),
                api.listEvents(goal.goalId),
              ]);
              return {
                goal,
                summary: goalStatusSummary({
                  goal: detail.goal,
                  steps: detail.steps,
                  nextStepId: detail.nextStepId,
                  approvals,
                  lastCheck: lastCheckFromEvents(events),
                }),
              };
            } catch {
              return {
                goal,
                summary: goalStatusSummary({ goal, steps: [], nextStepId: null, approvals: [], lastCheck: null }),
              };
            }
          }),
        );
        if (alive) setRows(summaries);
      },
      () => {
        if (alive) setLoadError('Your goals could not be loaded. Check your connection, then try again.');
      },
    );
    return () => {
      alive = false;
    };
  }, [api, reloadKey]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-sm text-text-secondary">
          Goals keep being checked while you do other things. Anything that changes something outside this app waits for
          your OK.
        </p>
        <Button.Primary type="button" onClick={() => setCreateOpen(true)}>
          New goal
        </Button.Primary>
      </div>

      {loadError !== null ? (
        <div className="flex flex-col items-center gap-3 px-3 py-8 text-center" role="alert">
          <p className="text-sm text-failure-bg">{loadError}</p>
          <Button.Secondary type="button" onClick={() => setReloadKey(key => key + 1)}>
            Try again
          </Button.Secondary>
        </div>
      ) : rows === null ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Loading goals">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm font-medium text-text-primary">No goals yet</p>
          <p className="max-w-md text-sm text-text-secondary">
            Start one here, or open a chat and choose Make this a goal. A goal starts as a draft, and nothing is checked
            until you review its card and activate it.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(({ goal, summary }) => (
            <li key={goal.goalId}>
              <button
                type="button"
                aria-label={`Open goal: ${goal.title}`}
                onClick={() => shell?.openGoals(goal.goalId)}
                className={cn(
                  'flex w-full flex-col gap-1 rounded-xl border border-border bg-card-bg px-4 py-3 text-left',
                  'transition-colors hover:bg-secondary-bg/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold',
                )}
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm leading-5 font-medium text-text-primary">{goal.title}</span>
                  <span className="inline-flex shrink-0 items-center rounded-full bg-primary-bg px-2 py-0.5 text-[0.6875rem] leading-4 font-medium text-text-secondary">
                    {summary.label}
                  </span>
                </span>
                {summary.reason !== null ? (
                  <span className="text-xs leading-5 text-text-secondary">{summary.reason}</span>
                ) : null}
                <span className="text-xs leading-5 text-text-secondary">
                  {goal.targetAt !== null
                    ? `Target ${formatGoalTarget({ iso: goal.targetAt, hasTime: goal.targetHasTime, timezone: goal.timezone })}. `
                    : ''}
                  {goal.lifecycle === 'active' && goal.nextCheckAt !== null
                    ? `Next check ${formatGoalDate({ iso: goal.nextCheckAt, timezone: goal.timezone })}.`
                    : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {createOpen ? (
        <GoalCreateDialog
          open
          onClose={() => setCreateOpen(false)}
          onCreated={detail => {
            setCreateOpen(false);
            shell?.openGoals(detail.goal.goalId);
          }}
        />
      ) : null}
    </div>
  );
}
