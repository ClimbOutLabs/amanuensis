'use client';

import { SCHEDULE_AWAY_NOTE } from '@truefoundry/trueforge-core/core/schedules/scheduleCardCopy';
import type { FC } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import type { SentinelApprovalSchedule, SentinelScheduleToolChoice, SentinelScheduleTools } from './types.js';

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-words text-text-primary">
      <span className="text-text-secondary">{label}: </span>
      {value}
    </p>
  );
}

function onNames(choices: readonly SentinelScheduleToolChoice[]): string {
  const names = choices.filter(choice => choice.on).map(choice => choice.name);
  return names.length === 0 ? 'None' : names.join(', ');
}

function onOff(value: boolean): string {
  return value ? 'On' : 'Off';
}

/** True when both hold the same choices, so the card still shows what an approval would save. */
export function sameScheduleTools(a: SentinelScheduleTools, b: SentinelScheduleTools): boolean {
  return (
    onNames(a.connectors) === onNames(b.connectors) &&
    onNames(a.skills) === onNames(b.skills) &&
    a.run_code === b.run_code &&
    a.memory === b.memory
  );
}

/** The words sent back when the person picks other tools, so the card is made again with exactly those. */
export function scheduleToolsRequest(tools: SentinelScheduleTools): string {
  return `Use exactly these for the schedule. Connectors: ${onNames(tools.connectors)}. Skills: ${onNames(tools.skills)}. Run code: ${onOff(tools.run_code)}. Memory: ${onOff(tools.memory)}`;
}

function Tick({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 break-words text-text-primary">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={event => {
          onChange(event.target.checked);
        }}
      />
      <span>
        {label}
        {hint !== undefined && <span className="text-text-secondary"> {hint}</span>}
      </span>
    </label>
  );
}

function TickGroup({
  title,
  empty,
  choices,
  disabled,
  onChange,
}: {
  title: string;
  empty: string;
  choices: readonly SentinelScheduleToolChoice[];
  disabled: boolean;
  onChange: (choices: SentinelScheduleToolChoice[]) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1 font-medium text-text-secondary">{title}</legend>
      {choices.length === 0 && <p className="text-text-secondary">{empty}</p>}
      {choices.map(choice => (
        <Tick
          key={choice.name}
          label={choice.name}
          checked={choice.on}
          disabled={disabled}
          onChange={on => {
            onChange(choices.map(other => (other.name === choice.name ? { ...other, on } : other)));
          }}
        />
      ))}
    </fieldset>
  );
}

export type ScheduleToolsPicker = {
  /** The choices as the person has them now; starts as what the card sent. */
  picked: SentinelScheduleTools;
  onPick: (tools: SentinelScheduleTools) => void;
  /** Asks for the card again with the picked choices. */
  onUpdate: () => void;
  disabled: boolean;
};

/** What the schedule runs with. Tick boxes when the person may choose, plain rows otherwise. */
function ScheduleTools({ tools, picker }: { tools: SentinelScheduleTools; picker: ScheduleToolsPicker | undefined }) {
  if (!tools.editable || picker === undefined) {
    return (
      <div data-role="schedule-tools">
        <Line label="Connectors" value={onNames(tools.connectors)} />
        <Line label="Skills" value={onNames(tools.skills)} />
        <Line label="Run code" value={onOff(tools.run_code)} />
        <Line label="Memory" value={onOff(tools.memory)} />
      </div>
    );
  }
  const { picked, onPick, onUpdate, disabled } = picker;
  const anySkill = picked.skills.some(skill => skill.on);
  const changed = !sameScheduleTools(picked, tools);
  return (
    <div className="space-y-3" data-role="schedule-tools">
      <p className="text-text-secondary" data-role="schedule-tools-note">
        Pick what this schedule may use. Your choices are saved as {tools.agent_name}, and you can change them later.
      </p>
      <TickGroup
        title="Connectors"
        empty="You have no connectors set up."
        choices={picked.connectors}
        disabled={disabled}
        onChange={connectors => {
          onPick({ ...picked, connectors });
        }}
      />
      <TickGroup
        title="Skills"
        empty="You have no skills set up."
        choices={picked.skills}
        disabled={disabled}
        onChange={skills => {
          onPick({ ...picked, skills, run_code: picked.run_code || skills.some(skill => skill.on) });
        }}
      />
      <fieldset>
        <legend className="mb-1 font-medium text-text-secondary">Other</legend>
        <Tick
          label="Run code"
          {...(anySkill ? { hint: 'Skills need it.' } : {})}
          checked={picked.run_code}
          disabled={disabled || anySkill}
          onChange={run_code => {
            onPick({ ...picked, run_code });
          }}
        />
        <Tick
          label="Memory"
          hint="Recall what you saved."
          checked={picked.memory}
          disabled={disabled}
          onChange={memory => {
            onPick({ ...picked, memory });
          }}
        />
      </fieldset>
      {changed && (
        <div className="space-y-2" data-role="schedule-tools-changed">
          <p className="text-text-primary">You changed the choices. Update the card, then approve it.</p>
          <Button variant="primary" size="small" onClick={onUpdate} disabled={disabled}>
            Update the card
          </Button>
        </div>
      )}
    </div>
  );
}

/** The whole schedule a chat call creates or deletes, in plain words; every row comes from the server. */
export const ScheduleDetails: FC<{ schedule: SentinelApprovalSchedule; picker?: ScheduleToolsPicker | undefined }> = ({
  schedule,
  picker,
}) => (
  <div className="space-y-3 rounded-lg bg-primary-bg px-3 py-2.5" data-role="schedule">
    <div>
      <Line label="Name" value={schedule.name} />
      <Line label="When it runs" value={`${schedule.when} (${schedule.time_zone})`} />
      <Line label="Runs as" value={schedule.runs_as} />
      {schedule.action === 'create' && <Line label="Starts" value="As soon as you approve." />}
    </div>
    {schedule.next_runs.length > 0 && (
      <div>
        <p className="mb-1 font-medium text-text-secondary">Next runs</p>
        <ul className="list-disc pl-5 text-text-primary">
          {schedule.next_runs.map(run => (
            <li key={run}>{run}</li>
          ))}
        </ul>
      </div>
    )}
    <div>
      <p className="mb-1 font-medium text-text-secondary">What it will do each time</p>
      <div
        role="region"
        aria-label="Schedule instruction"
        tabIndex={0}
        className="max-h-60 overflow-auto rounded border border-border bg-card-bg px-3 py-2"
      >
        <p className="whitespace-pre-wrap break-words text-text-primary">{schedule.task}</p>
      </div>
    </div>
    {schedule.tools !== undefined && <ScheduleTools tools={schedule.tools} picker={picker} />}
    {schedule.action === 'create' && (
      <p className="text-text-secondary" data-role="schedule-away">
        {SCHEDULE_AWAY_NOTE}
      </p>
    )}
  </div>
);
