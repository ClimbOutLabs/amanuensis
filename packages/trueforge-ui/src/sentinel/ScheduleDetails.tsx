'use client';

import type { FC } from 'react';

import type { SentinelApprovalSchedule } from './types.js';

/** Scheduled runs hold anything that would ask, so nobody approves it by accident while away. */
const SCHEDULE_AWAY_NOTE =
  "While you're away it can only read and write to chat; anything risky is skipped and waits for your OK.";

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-words text-text-primary">
      <span className="text-text-secondary">{label}: </span>
      {value}
    </p>
  );
}

/** The whole schedule a chat call creates or deletes, in plain words; every row comes from the server. */
export const ScheduleDetails: FC<{ schedule: SentinelApprovalSchedule }> = ({ schedule }) => (
  <div className="space-y-3 rounded border border-border bg-primary-bg px-3 py-2" data-role="schedule">
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
    {schedule.action === 'create' && (
      <p className="text-text-secondary" data-role="schedule-away">
        {SCHEDULE_AWAY_NOTE}
      </p>
    )}
  </div>
);
