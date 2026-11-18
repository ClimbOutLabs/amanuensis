'use client';

import { useState } from 'react';

import { useGoals } from '../../goals/GoalsContext.js';
import type { GoalDetail } from '../../goals/types.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../primitives/Dialog.js';

const inputClass = 'w-full rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary';
const labelClass = 'flex flex-col gap-1 text-sm text-text-primary';

/**
 * Edits a goal's own words and limits. On an active goal the service refuses
 * changes that alter what the goal is or how it works, because those need a
 * new activation card; the refusal message is shown as it comes back.
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
  const [title, setTitle] = useState(goal.title);
  const [outcome, setOutcome] = useState(goal.outcome);
  const [criteriaText, setCriteriaText] = useState(goal.successCriteria.join('\n'));
  const [targetDate, setTargetDate] = useState(goal.targetAt === null ? '' : goal.targetAt.slice(0, 16));
  const [timezone, setTimezone] = useState(goal.timezone);
  const [checksPerDay, setChecksPerDay] = useState(String(goal.executionPolicy.checksPerDay));
  const [dailyAllowance, setDailyAllowance] = useState(String(goal.executionPolicy.dailyTokenAllowance));
  const [digest, setDigest] = useState(goal.notificationPolicy.digest);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedChecks = Number.parseInt(checksPerDay, 10);
  const parsedAllowance = Number.parseInt(dailyAllowance, 10);
  const valid =
    title.trim() !== '' &&
    outcome.trim() !== '' &&
    Number.isInteger(parsedChecks) &&
    parsedChecks >= 1 &&
    parsedChecks <= 24 &&
    Number.isInteger(parsedAllowance) &&
    parsedAllowance > 0;

  const save = () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    api
      .updateGoal(goal.goalId, {
        expectedRevision: goal.revision,
        title: title.trim(),
        outcome: outcome.trim(),
        successCriteria: criteriaText
          .split('\n')
          .map(line => line.trim())
          .filter(line => line !== ''),
        targetAt: targetDate === '' ? null : new Date(targetDate).toISOString(),
        timezone: timezone.trim() === '' ? goal.timezone : timezone.trim(),
        executionPolicy: {
          ...goal.executionPolicy,
          checksPerDay: parsedChecks,
          dailyTokenAllowance: parsedAllowance,
        },
        notificationPolicy: { digest },
      })
      .then(
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
          {goal.lifecycle === 'active' ? (
            <p className="text-sm text-text-secondary">
              On a running goal, wording and limits can change here. Changing what the goal is, its sources, or its
              agent needs a new activation card instead.
            </p>
          ) : null}
        </DialogHeader>
        <div className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto px-4 py-3">
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
              onChange={event => setCriteriaText(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className={`${labelClass} min-w-44 flex-1`}>
              <span>Target date and time</span>
              <input
                aria-label="Target date"
                type="datetime-local"
                className={inputClass}
                value={targetDate}
                onChange={event => setTargetDate(event.target.value)}
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
