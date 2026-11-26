'use client';

import { useEffect, useState } from 'react';

import { useGoals } from '../../goals/GoalsContext.js';
import { targetInstant, targetWallParts } from '../../goals/goalTargetTime.js';
import { parseWholeNumber } from '../../goals/parseWholeNumber.js';
import type { GoalAgentOption, GoalDetail, UpdateGoalInput } from '../../goals/types.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../primitives/Dialog.js';

const inputClass = 'w-full rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary';
const labelClass = 'flex flex-col gap-1 text-sm text-text-primary';

/**
 * Edits a goal, sending only the fields the owner actually changed. On a goal
 * that has started, the service refuses an edit that merely names what the
 * goal is working toward, even when the words are unchanged, so those fields
 * (the outcome, the done-when list, the target date, and the agent) are shown
 * read only here and never sent. The title, time zone, and work limits can
 * change on any goal, and a draft can still gain or change its agent here.
 */
export function GoalEditDialog({
  detail,
  onClose,
  onSaved,
}: {
  detail: GoalDetail;
  onClose: () => void;
  onSaved: (detail: GoalDetail) => void;
}) {
  const { api } = useGoals();
  const { goal } = detail;
  const started = goal.lifecycle !== 'draft';
  const [agents, setAgents] = useState<GoalAgentOption[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState(goal.agentId ?? '');
  const [title, setTitle] = useState(goal.title);
  const [outcome, setOutcome] = useState(goal.outcome);
  const [criteriaText, setCriteriaText] = useState(goal.successCriteria.join('\n'));
  // The target fields open on the stored target read in the goal's own zone.
  // A goal whose target has no time opens with the time empty, whatever hour
  // the stored instant happens to fall at.
  const initialTargetParts =
    goal.targetAt === null ? null : targetWallParts({ iso: goal.targetAt, timezone: goal.timezone });
  const initialTargetDate = initialTargetParts?.date ?? '';
  const initialTargetTime = goal.targetHasTime ? (initialTargetParts?.time ?? '') : '';
  const [targetDate, setTargetDate] = useState(initialTargetDate);
  const [targetTime, setTargetTime] = useState(initialTargetTime);
  const [timezone, setTimezone] = useState(goal.timezone);
  const [checksPerDay, setChecksPerDay] = useState(String(goal.executionPolicy.checksPerDay));
  const [dailyAllowance, setDailyAllowance] = useState(String(goal.executionPolicy.dailyTokenAllowance));
  const [digest, setDigest] = useState(goal.notificationPolicy.digest);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listAgents().then(
      list => {
        if (alive) setAgents(list);
      },
      () => {
        if (alive) setAgentsError('Your agents could not be loaded. Check your connection, then try again.');
      },
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const parsedChecks = parseWholeNumber(checksPerDay);
  const parsedAllowance = parseWholeNumber(dailyAllowance);
  const valid =
    title.trim() !== '' &&
    outcome.trim() !== '' &&
    parsedChecks !== null &&
    parsedChecks >= 1 &&
    parsedChecks <= 24 &&
    parsedAllowance !== null &&
    parsedAllowance > 0;

  // The edit is diffed against the goal as loaded, field by field, so an
  // untouched field is never sent. On a started goal the fields that say what
  // the goal is working toward are not offered for editing at all.
  const nextTimezone = timezone.trim() === '' ? goal.timezone : timezone.trim();
  const patch: Omit<UpdateGoalInput, 'expectedRevision'> = {};
  if (title.trim() !== goal.title) patch.title = title.trim();
  if (!started) {
    if (outcome.trim() !== goal.outcome) patch.outcome = outcome.trim();
    const criteria = criteriaText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '');
    if (JSON.stringify(criteria) !== JSON.stringify(goal.successCriteria)) patch.successCriteria = criteria;
    if (targetDate !== initialTargetDate || targetTime !== initialTargetTime) {
      patch.targetAt =
        targetDate === ''
          ? null
          : targetInstant({
              date: targetDate,
              time: targetTime === '' ? '00:00' : targetTime,
              timezone: nextTimezone,
            });
      patch.targetHasTime = targetDate !== '' && targetTime !== '';
    }
    if ((agentId === '' ? null : agentId) !== goal.agentId) patch.agentId = agentId === '' ? null : agentId;
  }
  if (nextTimezone !== goal.timezone) patch.timezone = nextTimezone;
  if (
    parsedChecks !== null &&
    parsedAllowance !== null &&
    (parsedChecks !== goal.executionPolicy.checksPerDay || parsedAllowance !== goal.executionPolicy.dailyTokenAllowance)
  ) {
    patch.executionPolicy = {
      ...goal.executionPolicy,
      checksPerDay: parsedChecks,
      dailyTokenAllowance: parsedAllowance,
    };
  }
  if (digest !== goal.notificationPolicy.digest) patch.notificationPolicy = { digest };
  const hasChanges = Object.keys(patch).length > 0;

  const save = () => {
    if (!valid) return;
    if (!hasChanges) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    api.updateGoal(goal.goalId, { expectedRevision: goal.revision, ...patch }).then(
      next => {
        setSaving(false);
        onSaved(next);
      },
      (caught: unknown) => {
        setSaving(false);
        setError(
          caught instanceof Error && caught.message !== ''
            ? caught.message
            : 'That change could not be saved. Try again in a moment.',
        );
      },
    );
  };

  const currentAgentName =
    goal.agentId === null
      ? null
      : (goal.pinnedSetup?.agentName ?? agents?.find(agent => agent.id === goal.agentId)?.name ?? null);

  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next) onClose();
      }}
      aria-label="Edit goal"
      className="max-w-xl"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit goal</DialogTitle>
          {started ? (
            <p className="text-sm text-text-secondary">
              On a goal that has started, the title, time zone, and work limits can change here. What the goal is
              working toward is fixed once it starts: its outcome, its done-when list, its sources, its target date, and
              its agent. To change any of those, end this goal and start a new one.
            </p>
          ) : (
            <p className="text-sm text-text-secondary">
              Everything here can change while the goal is a draft. It starts only when you activate it from the goal
              page.
            </p>
          )}
        </DialogHeader>
        <div className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto px-4 py-3">
          <label className={labelClass}>
            <span>Agent who will do the work</span>
            {started ? (
              <span className="text-text-secondary">
                {goal.agentId === null
                  ? 'No agent picked yet.'
                  : (currentAgentName ?? 'The agent picked when this goal started.')}
              </span>
            ) : agentsError !== null ? (
              <span role="alert" className="text-sm text-failure-bg">
                {agentsError}
              </span>
            ) : agents === null ? (
              <span className="text-text-secondary">Loading your agents…</span>
            ) : agents.length === 0 ? (
              <span className="text-text-secondary">
                You have no saved agents yet. Save an agent first, then give it this goal.
              </span>
            ) : (
              <select
                aria-label="Agent"
                className={inputClass}
                value={agentId}
                onChange={event => setAgentId(event.target.value)}
              >
                {agentId === '' ? <option value="">Choose an agent</option> : null}
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className={labelClass}>
            <span>Title</span>
            <input
              aria-label="Title"
              className={inputClass}
              value={title}
              onChange={event => setTitle(event.target.value)}
            />
          </label>
          <label className={labelClass}>
            <span>Outcome you want</span>
            <textarea
              aria-label="Outcome"
              className={inputClass}
              rows={2}
              value={outcome}
              disabled={started}
              onChange={event => setOutcome(event.target.value)}
            />
          </label>
          <label className={labelClass}>
            <span>How you will know it is done, one per line</span>
            <textarea
              aria-label="Success criteria"
              className={inputClass}
              rows={3}
              value={criteriaText}
              disabled={started}
              onChange={event => setCriteriaText(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className={`${labelClass} min-w-44 flex-1`}>
              <span>Target date</span>
              <input
                aria-label="Target date"
                type="date"
                className={inputClass}
                value={targetDate}
                disabled={started}
                onChange={event => setTargetDate(event.target.value)}
              />
            </label>
            <label className={`${labelClass} min-w-44 flex-1`}>
              <span>Time (optional)</span>
              <input
                aria-label="Target time"
                type="time"
                className={inputClass}
                value={targetTime}
                disabled={started}
                onChange={event => setTargetTime(event.target.value)}
              />
            </label>
            <label className={`${labelClass} min-w-44 flex-1`}>
              <span>Time zone</span>
              <input
                aria-label="Time zone"
                className={inputClass}
                value={timezone}
                onChange={event => setTimezone(event.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className={`${labelClass} min-w-36 flex-1`}>
              <span>Checks per day (1 to 24)</span>
              <input
                aria-label="Checks per day"
                inputMode="numeric"
                className={inputClass}
                value={checksPerDay}
                onChange={event => setChecksPerDay(event.target.value)}
              />
            </label>
            <label className={`${labelClass} min-w-36 flex-1`}>
              <span>Tokens per day</span>
              <input
                aria-label="Tokens per day"
                inputMode="numeric"
                className={inputClass}
                value={dailyAllowance}
                onChange={event => setDailyAllowance(event.target.value)}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={digest} onChange={event => setDigest(event.target.checked)} />
            <span>Send updates as one short digest</span>
          </label>
          {!valid ? (
            <p role="alert" className="text-sm text-failure-bg">
              Give the goal a title and an outcome, and keep the limits as whole numbers in range.
            </p>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-sm text-failure-bg">
              {error}
            </p>
          ) : null}
        </div>
      </DialogContent>
      <DialogFooter>
        <Button.Secondary type="button" onClick={onClose}>
          Cancel
        </Button.Secondary>
        <Button.Primary type="button" disabled={saving || !valid} onClick={save}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button.Primary>
      </DialogFooter>
    </Dialog>
  );
}
