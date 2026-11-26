'use client';

import { useState, type ReactNode } from 'react';

import { formatGoalTarget, goalSourceKindLabel, goalStepStatusLabel } from '../../goals/goalAttention.js';
import { parseWholeNumber } from '../../goals/parseWholeNumber.js';
import type { GoalActivationPreview, GoalExecutionPolicy, GoalNotificationPolicy } from '../../goals/types.js';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';

const CHECKS_PER_DAY_CHOICES: readonly { value: number; label: string; interval: string }[] = [
  { value: 1, label: 'Once a day', interval: 'about a day' },
  { value: 2, label: 'Twice a day', interval: 'about 12 hours' },
  { value: 3, label: 'Every 8 hours', interval: 'about 8 hours' },
  { value: 4, label: 'Every 6 hours', interval: 'about 6 hours' },
  { value: 6, label: 'Every 4 hours', interval: 'about 4 hours' },
  { value: 8, label: 'Every 3 hours', interval: 'about 3 hours' },
  { value: 12, label: 'Every 2 hours', interval: 'about 2 hours' },
  { value: 24, label: 'Every hour', interval: 'about an hour' },
];

function checksChoice(checksPerDay: number): { label: string; interval: string } {
  return (
    CHECKS_PER_DAY_CHOICES.find(choice => choice.value === checksPerDay) ?? {
      label: `${String(checksPerDay)} times a day`,
      interval: 'about a day',
    }
  );
}

function CardSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-text-secondary uppercase">{title}</h3>
      <div className="text-sm leading-6 text-text-primary">{children}</div>
    </section>
  );
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/**
 * The card the owner reviews before a goal starts: what it is for, who does the
 * work, what may be read, how often it checks, and the limits it runs under.
 * Plain units on the face; the numbers live in Advanced. Activating binds to
 * the setup digest this card shows, so a setup that changed since the card was
 * drawn refuses and the page shows the updated card instead.
 */
export function GoalActivationCard({
  preview,
  setupChanged,
  busy,
  error,
  onActivate,
}: {
  preview: GoalActivationPreview;
  /** True when this card replaced one the owner had already seen, because the agent setup changed. */
  setupChanged: boolean;
  busy: boolean;
  error: string | null;
  onActivate: (input: { executionPolicy: GoalExecutionPolicy; notificationPolicy: GoalNotificationPolicy }) => void;
}) {
  const { goal, steps, setup } = preview;
  const [checksPerDay, setChecksPerDay] = useState(goal.executionPolicy.checksPerDay);
  const [dailyAllowance, setDailyAllowance] = useState(String(goal.executionPolicy.dailyTokenAllowance));
  const [digest, setDigest] = useState(goal.notificationPolicy.digest);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const choice = checksChoice(checksPerDay);
  const parsedAllowance = parseWholeNumber(dailyAllowance);
  const allowanceValid = parsedAllowance !== null && parsedAllowance > 0;
  const stepName = (stepId: string) => steps.find(step => step.stepId === stepId)?.description ?? 'an earlier step';

  const activate = () => {
    if (parsedAllowance === null || parsedAllowance <= 0) return;
    onActivate({
      executionPolicy: { ...goal.executionPolicy, checksPerDay, dailyTokenAllowance: parsedAllowance },
      notificationPolicy: { digest },
    });
  };

  return (
    <div className="flex flex-col gap-5 rounded-xl border border-border bg-card-bg p-5" aria-label="Activation card">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-text-primary">Review and activate</h2>
        <p className="text-sm text-text-secondary">
          Nothing is checked or watched until you activate. After that, this goal is checked on the schedule below.
        </p>
        {setupChanged ? (
          <p role="alert" className="rounded-lg bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg">
            The agent setup changed since this card was first shown, so it was not activated. This is the updated card.
            Review it, then activate again.
          </p>
        ) : null}
      </div>

      <CardSection title="Outcome">
        <p>{goal.outcome}</p>
        {goal.successCriteria.length > 0 ? (
          <ul className="list-disc pl-5">
            {goal.successCriteria.map(criterion => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-text-secondary">
          {goal.targetAt !== null
            ? `By ${formatGoalTarget({ iso: goal.targetAt, hasTime: goal.targetHasTime, timezone: goal.timezone })} (${goal.timezone})`
            : 'No target date.'}
        </p>
      </CardSection>

      <CardSection title="Plan">
        {steps.length === 0 ? (
          <p className="text-text-secondary">No steps yet. The first check will work from the outcome alone.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {steps.map(step => (
              <li key={step.stepId} className="flex flex-wrap items-baseline gap-x-2">
                <span>{step.description}</span>
                <span className="text-xs text-text-secondary">{goalStepStatusLabel(step.status)}</span>
                {step.dependsOn.length > 0 ? (
                  <span className="text-xs text-text-secondary">
                    after {step.dependsOn.map(dependency => stepName(dependency)).join(', ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </CardSection>

      <CardSection title="Who does the work">
        <p>
          {setup.agentName} · {setup.modelName}
        </p>
        <p className="text-text-secondary">
          {setup.mcpServerNames.length > 0
            ? `Connected tools: ${setup.mcpServerNames.join(', ')}.`
            : 'No connected tool servers.'}{' '}
          {setup.skillNames.length > 0 ? `Skills: ${setup.skillNames.join(', ')}.` : 'No skills.'}
        </p>
        <p className="text-text-secondary">
          This exact setup is pinned when you activate. If it changes later, the goal stops and asks you to review a new
          card.
        </p>
      </CardSection>

      <CardSection title="Sources it may read">
        {goal.selectedSources.length === 0 ? (
          <p className="text-text-secondary">No sources selected. Checks will have nothing to read.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {goal.selectedSources.map(source => (
              <li key={`${source.sourceKind}:${source.sourceRef}`}>
                {source.label}{' '}
                <span className="text-xs text-text-secondary">{goalSourceKindLabel(source.sourceKind)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-text-secondary">Only these sources are read during a check. Nothing else is opened.</p>
      </CardSection>

      <CardSection title="What happens on its own, and what waits for you">
        <p>On each check, the goal reads the sources above, records what is new as evidence, and updates the plan.</p>
        <p>
          Anything that would change something outside this app, such as sending a message or booking something, waits
          for your OK first. You confirm completion yourself when the goal is done.
        </p>
      </CardSection>

      <CardSection title="Checks">
        <label className="flex flex-wrap items-center gap-2">
          <span>Routine checks</span>
          <select
            aria-label="Routine checks"
            className="rounded-md border border-border bg-primary-bg px-2 py-1 text-sm text-text-primary"
            value={checksPerDay}
            onChange={event => setChecksPerDay(Number(event.target.value))}
          >
            {CHECKS_PER_DAY_CHOICES.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-text-secondary">
          Once a day is the usual choice. Checking more often is your choice to make here, and only here. The first
          check runs {choice.interval} after you activate, and you can run one sooner with Check now.
        </p>
        <p className="text-text-secondary">
          A check may work for up to about {String(goal.executionPolicy.cycleMinutes)} minutes at a time.
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={digest} onChange={event => setDigest(event.target.checked)} />
          <span>Send updates as one short digest instead of one message per event</span>
        </label>
      </CardSection>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="self-start text-sm font-medium text-text-primary underline underline-offset-2"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen(open => !open)}
        >
          Advanced: work limits
        </button>
        {advancedOpen ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border px-4 py-3 text-sm text-text-primary">
            <p>One check may use at most:</p>
            <ul className="list-disc pl-5">
              <li>{String(goal.executionPolicy.cycleMinutes)} minutes</li>
              <li>{String(goal.executionPolicy.modelCallLimit)} model calls</li>
              <li>{String(goal.executionPolicy.toolCallLimit)} tool calls</li>
              <li>{formatTokens(goal.executionPolicy.cycleTokenLimit)} tokens</li>
            </ul>
            <label className="flex flex-wrap items-center gap-2">
              <span>Tokens this goal may use per day, across all checks</span>
              <input
                aria-label="Tokens per day"
                inputMode="numeric"
                className={cn(
                  'w-32 rounded-md border bg-primary-bg px-2 py-1 text-sm text-text-primary',
                  allowanceValid ? 'border-border' : 'border-failure-bg',
                )}
                value={dailyAllowance}
                onChange={event => setDailyAllowance(event.target.value)}
              />
            </label>
            {!allowanceValid ? (
              <p role="alert" className="text-sm text-failure-bg">
                Enter a whole number of tokens above zero.
              </p>
            ) : null}
            <p className="text-text-secondary">
              Whichever limit is reached first stops the check. The goal page then shows Work limit reached, with the
              next step saved.
            </p>
          </div>
        ) : null}
      </div>

      {error !== null ? (
        <p role="alert" className="text-sm text-failure-bg">
          {error}
        </p>
      ) : null}
      <div>
        <Button.Primary type="button" disabled={busy || !allowanceValid} onClick={activate}>
          {busy ? 'Activating…' : 'Activate goal'}
        </Button.Primary>
      </div>
    </div>
  );
}
