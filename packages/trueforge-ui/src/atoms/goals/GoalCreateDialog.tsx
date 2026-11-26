'use client';

import { useEffect, useState } from 'react';

import { useGoals } from '../../goals/GoalsContext.js';
import { targetInstant } from '../../goals/goalTargetTime.js';
import type { CreateGoalInput, GoalAgentOption, GoalDetail, GoalSourceKind, GoalSourceRef } from '../../goals/types.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../primitives/Dialog.js';

const SOURCE_KINDS: readonly { value: GoalSourceKind; label: string }[] = [
  { value: 'document', label: 'Document' },
  { value: 'space', label: 'Space' },
  { value: 'mail', label: 'Mail' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'web', label: 'Web page' },
  { value: 'manual', label: 'Added by hand' },
];

type SourceDraft = { kind: GoalSourceKind; label: string; ref: string };
type StepDraft = { description: string; acceptanceCriteria: string; dependsOn: number[]; sourceIndexes: number[] };

const inputClass = 'w-full rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary';
const labelClass = 'flex flex-col gap-1 text-sm text-text-primary';

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The new goal form, shared by New goal on the Goals page and Make this a goal
 * in a chat. It makes a draft only: the goal starts when the owner reviews the
 * activation card on the goal page and activates it.
 */
export function GoalCreateDialog({
  open,
  initialAgentId,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** The agent of the chat the form was opened from, when that chat has one. */
  initialAgentId?: string | null;
  onClose: () => void;
  onCreated: (detail: GoalDetail) => void;
}) {
  const { api } = useGoals();
  const [agents, setAgents] = useState<GoalAgentOption[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [criteriaText, setCriteriaText] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [targetTime, setTargetTime] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone);
  const [sources, setSources] = useState<SourceDraft[]>([]);
  const [steps, setSteps] = useState<StepDraft[]>([
    { description: '', acceptanceCriteria: '', dependsOn: [], sourceIndexes: [] },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAgentsError(null);
    api.listAgents().then(
      list => {
        if (!alive) return;
        setAgents(list);
        setAgentId(current => current || initialAgentId || list[0]?.id || '');
      },
      () => {
        if (alive) setAgentsError('Your agents could not be loaded. Check your connection, then try again.');
      },
    );
    return () => {
      alive = false;
    };
  }, [api, open, initialAgentId]);

  if (!open) return null;

  const updateSource = (index: number, patch: Partial<SourceDraft>) => {
    setSources(current => current.map((source, i) => (i === index ? { ...source, ...patch } : source)));
  };
  const updateStep = (index: number, patch: Partial<StepDraft>) => {
    setSteps(current => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  };
  const toggleStepList = (stepIndex: number, key: 'dependsOn' | 'sourceIndexes', value: number) => {
    setSteps(current =>
      current.map((step, i) => {
        if (i !== stepIndex) return step;
        const list = step[key].includes(value) ? step[key].filter(entry => entry !== value) : [...step[key], value];
        return { ...step, [key]: list };
      }),
    );
  };

  const completeSources: GoalSourceRef[] = sources
    .filter(source => source.label.trim() !== '' && source.ref.trim() !== '')
    .map(source => ({ sourceKind: source.kind, sourceRef: source.ref.trim(), label: source.label.trim() }));

  const canSave =
    !saving &&
    agentId !== '' &&
    title.trim() !== '' &&
    outcome.trim() !== '' &&
    steps.some(step => step.description.trim() !== '');

  const save = () => {
    const sourceIndexByDraft = new Map<number, number>();
    sources.forEach((source, index) => {
      if (source.label.trim() !== '' && source.ref.trim() !== '') {
        sourceIndexByDraft.set(
          index,
          completeSources.findIndex(entry => entry.sourceRef === source.ref.trim()),
        );
      }
    });
    // Dependencies and source picks are recorded against the form's rows; empty
    // rows drop out here, so both are remapped onto the steps actually sent.
    const keptStepIndexes = steps
      .map((step, index) => (step.description.trim() !== '' ? index : -1))
      .filter(index => index >= 0);
    const keptPositionByDraft = new Map(keptStepIndexes.map((draftIndex, position) => [draftIndex, position]));
    const effectiveTimezone = timezone.trim() === '' ? 'UTC' : timezone.trim();
    // A date with no time is a date alone: the goal records that no time was
    // given, and the stored instant is the start of the date in its zone.
    const input: CreateGoalInput = {
      agentId,
      title: title.trim(),
      outcome: outcome.trim(),
      successCriteria: criteriaText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== ''),
      targetAt:
        targetDate === ''
          ? null
          : targetInstant({
              date: targetDate,
              time: targetTime === '' ? '00:00' : targetTime,
              timezone: effectiveTimezone,
            }),
      targetHasTime: targetDate !== '' && targetTime !== '',
      timezone: effectiveTimezone,
      selectedSources: completeSources,
      steps: keptStepIndexes.map(draftIndex => {
        const step = steps[draftIndex];
        if (step === undefined) {
          return { description: '', dependsOnIndexes: [], acceptanceCriteria: '', sourceRefs: [] };
        }
        return {
          description: step.description.trim(),
          dependsOnIndexes: step.dependsOn
            .map(dependency => keptPositionByDraft.get(dependency))
            .filter((position): position is number => position !== undefined),
          acceptanceCriteria: step.acceptanceCriteria.trim(),
          sourceRefs: step.sourceIndexes
            .map(index => sourceIndexByDraft.get(index))
            .filter((index): index is number => index !== undefined && index >= 0)
            .map(index => completeSources[index]?.sourceRef ?? '')
            .filter(ref => ref !== ''),
        };
      }),
    };
    setSaving(true);
    setError(null);
    api.createGoal(input).then(
      detail => {
        setSaving(false);
        onCreated(detail);
      },
      () => {
        setSaving(false);
        setError('That goal could not be created. Check your connection, then try again.');
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next) onClose();
      }}
      aria-label="New goal"
      className="max-w-2xl"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New goal</DialogTitle>
          <p className="text-sm text-text-secondary">
            This makes a draft. Nothing is checked until you review the activation card and activate the goal.
          </p>
        </DialogHeader>
        <div className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto px-4 py-3">
          <label className={labelClass}>
            <span>Agent who will do the work</span>
            {agentsError !== null ? (
              <span role="alert" className="text-sm text-failure-bg">
                {agentsError}
              </span>
            ) : agents === null ? (
              <span className="text-text-secondary">Loading your agents…</span>
            ) : agents.length === 0 ? (
              <span className="text-text-secondary">
                You have no saved agents yet. Save an agent first, then make the goal.
              </span>
            ) : (
              <select
                aria-label="Agent"
                className={inputClass}
                value={agentId}
                onChange={event => setAgentId(event.target.value)}
              >
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
              placeholder="Community fundraiser"
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
              placeholder="Have the venue, volunteers, and equipment confirmed by June 1"
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
              placeholder={'Venue confirmed in writing\nEquipment booked'}
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

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-text-primary">Sources it may read</legend>
            <p className="text-xs text-text-secondary">
              Only these are read during a check. A source needs the name you call it and its reference, such as a space
              id or a document name.
            </p>
            {sources.map((source, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-32 flex-col gap-1 text-xs text-text-secondary">
                  Kind
                  <select
                    aria-label={`Source ${String(index + 1)} kind`}
                    className={inputClass}
                    value={source.kind}
                    onChange={event => {
                      const kind = SOURCE_KINDS.find(entry => entry.value === event.target.value);
                      if (kind !== undefined) updateSource(index, { kind: kind.value });
                    }}
                  >
                    {SOURCE_KINDS.map(kind => (
                      <option key={kind.value} value={kind.value}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-text-secondary">
                  Name
                  <input
                    aria-label={`Source ${String(index + 1)} name`}
                    className={inputClass}
                    value={source.label}
                    onChange={event => updateSource(index, { label: event.target.value })}
                    placeholder="Venue booking letter"
                  />
                </label>
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-text-secondary">
                  Reference
                  <input
                    aria-label={`Source ${String(index + 1)} reference`}
                    className={inputClass}
                    value={source.ref}
                    onChange={event => updateSource(index, { ref: event.target.value })}
                    placeholder="venue-booking-letter"
                  />
                </label>
                <Button.Secondary
                  type="button"
                  onClick={() => setSources(current => current.filter((_, i) => i !== index))}
                >
                  Remove
                </Button.Secondary>
              </div>
            ))}
            <div>
              <Button.Secondary
                type="button"
                onClick={() => setSources(current => [...current, { kind: 'document', label: '', ref: '' }])}
              >
                Add a source
              </Button.Secondary>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-text-primary">Steps</legend>
            {steps.map((step, index) => (
              <div key={index} className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2">
                <label className={labelClass}>
                  <span>Step {String(index + 1)}</span>
                  <input
                    aria-label={`Step ${String(index + 1)}`}
                    className={inputClass}
                    value={step.description}
                    onChange={event => updateStep(index, { description: event.target.value })}
                    placeholder="Confirm the venue"
                  />
                </label>
                <label className={labelClass}>
                  <span>Done when (optional)</span>
                  <input
                    aria-label={`Step ${String(index + 1)} done when`}
                    className={inputClass}
                    value={step.acceptanceCriteria}
                    onChange={event => updateStep(index, { acceptanceCriteria: event.target.value })}
                    placeholder="The venue confirms in writing"
                  />
                </label>
                {index > 0 ? (
                  <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
                    <span>Comes after:</span>
                    {steps.slice(0, index).map((earlier, earlierIndex) => (
                      <label key={earlierIndex} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={step.dependsOn.includes(earlierIndex)}
                          onChange={() => toggleStepList(index, 'dependsOn', earlierIndex)}
                        />
                        Step {String(earlierIndex + 1)}
                      </label>
                    ))}
                  </div>
                ) : null}
                {sources.length > 0 ? (
                  <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
                    <span>Listens to:</span>
                    {sources.map((source, sourceIndex) => (
                      <label key={sourceIndex} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={step.sourceIndexes.includes(sourceIndex)}
                          onChange={() => toggleStepList(index, 'sourceIndexes', sourceIndex)}
                        />
                        {source.label.trim() === '' ? `Source ${String(sourceIndex + 1)}` : source.label}
                      </label>
                    ))}
                  </div>
                ) : null}
                {steps.length > 1 ? (
                  <div>
                    <Button.Secondary
                      type="button"
                      onClick={() => setSteps(current => current.filter((_, i) => i !== index))}
                    >
                      Remove step
                    </Button.Secondary>
                  </div>
                ) : null}
              </div>
            ))}
            <div>
              <Button.Secondary
                type="button"
                onClick={() =>
                  setSteps(current => [
                    ...current,
                    { description: '', acceptanceCriteria: '', dependsOn: [], sourceIndexes: [] },
                  ])
                }
              >
                Add a step
              </Button.Secondary>
            </div>
          </fieldset>

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
        <Button.Primary type="button" disabled={!canSave} onClick={save}>
          {saving ? 'Creating…' : 'Create draft'}
        </Button.Primary>
      </DialogFooter>
    </Dialog>
  );
}
