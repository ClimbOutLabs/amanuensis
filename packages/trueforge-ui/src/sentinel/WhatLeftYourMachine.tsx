'use client';

import { useCallback, useEffect, useState, type FC } from 'react';

import { useOptionalSentinelApi } from './SentinelApiContext.js';
import { groupOutboundEvents, type OutboundRow } from './outboundGroups.js';
import type { DataLocation, OutboundActivity, OutboundEvent, OutboundEventKind } from './types.js';

export const NOTHING_LEFT_MESSAGE = 'Nothing has left this computer in the last 24 hours.';

/** Clock time with seconds, plus the day when it is not today: the list spans 24 hours. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(
    date,
  );
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)}, ${time}`;
}

const When: FC<{ at: string }> = ({ at }) => (
  <time dateTime={at} title={at} className="shrink-0 text-xs text-text-secondary">
    {formatWhen(at)}
  </time>
);

const KIND_LABELS: Record<OutboundEventKind, string> = {
  model_request: 'Model request',
  email_sent: 'Email sent',
  web_search: 'Web search',
  map_lookup: 'Map lookup',
  connector_call: 'Connector call',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'TB'}`;
}

function chatLabel(conversationId: string | null): string {
  return conversationId === null ? 'no chat' : `chat ...${conversationId.slice(-6)}`;
}

function eventDetail(event: OutboundEvent): string {
  const parts: string[] = [];
  if (event.kind === 'model_request' && event.model !== null) parts.push(event.model);
  if (event.kind === 'email_sent') {
    parts.push(
      event.recipient_count === null
        ? 'recipients not listed in the call'
        : `${String(event.recipient_count)} ${event.recipient_count === 1 ? 'recipient' : 'recipients'}`,
    );
    if (event.subject !== null) parts.push(`subject "${event.subject}"`);
  }
  if (event.kind !== 'model_request' && event.kind !== 'email_sent' && event.tool_name !== null) {
    parts.push(event.tool_name);
  }
  if (event.request_bytes !== null) parts.push(`${formatBytes(event.request_bytes)} sent`);
  if (event.kind === 'model_request') parts.push(chatLabel(event.conversation_id));
  return parts.join(' · ');
}

const EventRow: FC<{ event: OutboundEvent }> = ({ event }) => (
  <li className="border-b border-border/60 px-3 py-2 last:border-b-0" data-kind={event.kind}>
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 truncate text-sm font-medium text-text-primary">
        {KIND_LABELS[event.kind]} to <span className="font-mono text-xs">{event.host}</span>
      </span>
      <When at={event.created_at} />
    </div>
    <p className="mt-0.5 break-words text-xs text-text-secondary">{eventDetail(event)}</p>
  </li>
);

const GroupRow: FC<{ row: Extract<OutboundRow, { type: 'model_requests' }> }> = ({ row }) => (
  <li className="border-b border-border/60 px-3 py-2 last:border-b-0" data-kind="model_request" data-grouped="true">
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 truncate text-sm font-medium text-text-primary">
        {String(row.count)} model requests to <span className="font-mono text-xs">{row.host}</span>
      </span>
      <When at={row.latest_at} />
    </div>
    <p className="mt-0.5 break-words text-xs text-text-secondary">
      {[
        row.model,
        row.total_bytes === null ? null : `${formatBytes(row.total_bytes)} sent in all`,
        chatLabel(row.conversation_id),
      ]
        .filter(part => part !== null)
        .join(' · ')}
    </p>
  </li>
);

const LocationRow: FC<{ location: DataLocation }> = ({ location }) => (
  <li className="border-b border-border/60 px-3 py-2 last:border-b-0" data-location={location.id}>
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-sm font-medium text-text-primary">{location.name}</span>
      <span className="shrink-0 text-xs text-text-secondary">
        {location.size_bytes === null ? 'size not measured' : formatBytes(location.size_bytes)}
      </span>
    </div>
    <p className="mt-0.5 break-words text-xs text-text-secondary">{location.where}</p>
    {location.size_bytes !== null && location.size_covers !== null && (
      <p className="mt-0.5 text-xs text-text-secondary">Size covers {location.size_covers}.</p>
    )}
  </li>
);

function errorText(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Request failed.';
}

/**
 * Settings > What left your machine: where Aman keeps data on this computer, and every request that
 * went to an outside service in the last 24 hours. Both lists come from real records the server
 * keeps; nothing is estimated, and an empty list says so.
 */
export const WhatLeftYourMachine: FC = () => {
  const api = useOptionalSentinelApi();
  const [locations, setLocations] = useState<DataLocation[] | null>(null);
  const [activity, setActivity] = useState<OutboundActivity | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (api === null) return;
    try {
      const [nextLocations, nextActivity] = await Promise.all([api.listDataLocations(), api.listOutboundActivity()]);
      setLocations(nextLocations);
      setActivity(nextActivity);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (api === null) {
    return (
      <p className="text-sm text-text-secondary">This page is unavailable: the host did not provide a Sentinel API.</p>
    );
  }

  const rows = activity === null ? [] : groupOutboundEvents(activity.events);

  return (
    <div className="flex min-h-0 flex-col gap-6 overflow-y-auto pb-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">What left your machine</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Whose computer is it on? Yours. This page shows where Aman keeps your data and everything it sent to an
          outside service in the last 24 hours. Requests to services on this computer itself are not counted.
        </p>
      </div>

      {error !== null && (
        <p className="text-sm text-failure-bg" role="alert">
          {error}
        </p>
      )}

      <section aria-labelledby="keeps-heading">
        <h3 id="keeps-heading" className="text-sm font-semibold text-text-primary">
          What Aman keeps, and where
        </h3>
        {locations !== null && (
          <ul className="mt-2 rounded-lg border border-border">
            {locations.map(location => (
              <LocationRow key={location.id} location={location} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="went-out-heading">
        <h3 id="went-out-heading" className="text-sm font-semibold text-text-primary">
          What went out in the last 24 hours
        </h3>
        {activity !== null && activity.events.length === 0 && (
          <p className="mt-2 rounded-lg border border-border p-4 text-sm text-text-secondary">{NOTHING_LEFT_MESSAGE}</p>
        )}
        {activity !== null && activity.events.length > 0 && (
          <>
            <p className="mt-1 text-xs text-text-secondary">
              Newest first. Only the service, the time and the size are kept, never what was written.
              {activity.truncated ? ' Older requests in this window are not shown.' : ''}
            </p>
            <ul className="mt-2 rounded-lg border border-border">
              {rows.map(row =>
                row.type === 'event' ? (
                  <EventRow key={row.event.id} event={row.event} />
                ) : (
                  <GroupRow key={row.key} row={row} />
                ),
              )}
            </ul>
          </>
        )}
      </section>
    </div>
  );
};
