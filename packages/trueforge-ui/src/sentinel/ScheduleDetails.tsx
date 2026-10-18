'use client';

import type { FC } from 'react';

import type { SentinelApprovalSchedule, SentinelApprovalScheduleAction } from './types.js';

export const SCHEDULE_BADGES: Record<SentinelApprovalScheduleAction, string> = {
  create: 'New schedule',
  delete: 'Delete schedule',
};

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-words text-sm text-text-primary">
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
      {schedule.action === 'create' && (
        <Line
          label="Starts"
          value={
            schedule.first_run === null
              ? 'As soon as you approve.'
              : `As soon as you approve. First run: ${schedule.first_run}.`
          }
        />
      )}
    </div>
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">What it will do each time</p>
      <div
        role="region"
        aria-label="Schedule instruction"
        tabIndex={0}
        className="max-h-60 overflow-auto rounded border border-border bg-card-bg px-3 py-2"
      >
        <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{schedule.task}</p>
      </div>
    </div>
  </div>
);
