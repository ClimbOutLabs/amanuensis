'use client';

import type { FC } from 'react';

import type { SentinelApprovalCalendarEvent } from './types.js';

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-words text-sm text-text-primary">
      <span className="text-text-secondary">{label}: </span>
      {value}
    </p>
  );
}

/**
 * The whole event a calendar write saves, in plain words: every row comes from the server, and the guests are
 * always listed with whether Google emails them, because adding a guest sends mail.
 */
export const CalendarEventDetails: FC<{ event: SentinelApprovalCalendarEvent }> = ({ event }) => {
  const { before } = event;
  return (
    <div className="space-y-3 rounded border border-border bg-primary-bg px-3 py-2" data-role="calendar-event">
      {before !== null && (
        <div>
          <p className="mb-1 text-xs font-medium text-text-secondary">Now</p>
          <Line label="Title" value={before.title} />
          <Line label="When" value={before.when} />
          {before.duration !== '' && <Line label="Length" value={before.duration} />}
          {before.location !== '' && <Line label="Where" value={before.location} />}
        </div>
      )}
      <div>
        <p className="mb-1 text-xs font-medium text-text-secondary">
          {before === null ? 'Exactly what will be saved' : 'After the change'}
        </p>
        <Line label="Calendar" value={`Main calendar of ${event.calendar}`} />
        <Line label="Title" value={event.title} />
        <Line label="When" value={event.when} />
        <Line label="Time zone" value={event.time_zone} />
        <Line label="Length" value={event.duration} />
        {event.location !== '' && <Line label="Where" value={event.location} />}
        {event.one_of_repeating && <Line label="Repeats" value="Only this one event of the series changes" />}
        <Line label="Guests" value={event.attendees.length === 0 ? 'None' : event.attendees.join(', ')} />
        {event.attendees.length > 0 && (
          <p className="text-sm font-medium text-text-primary" data-role="calendar-guests-emailed">
            {event.guests_emailed
              ? 'Google will email every guest about this.'
              : 'Google will not email the guests about this.'}
          </p>
        )}
      </div>
      {event.description !== '' && (
        <div>
          <p className="mb-1 text-xs font-medium text-text-secondary">Description</p>
          <div
            role="region"
            aria-label="Event description"
            tabIndex={0}
            className="max-h-60 overflow-auto rounded border border-border bg-card-bg px-3 py-2"
          >
            <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{event.description}</p>
          </div>
        </div>
      )}
    </div>
  );
};
