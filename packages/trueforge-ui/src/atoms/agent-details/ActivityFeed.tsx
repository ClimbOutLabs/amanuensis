'use client';

import { useMemo, useState, type ComponentType } from 'react';

import { buildActivityItems, type ActivityItemKind } from '../../utils/activityFeed.js';
import { cn } from '../lib/cn.js';
import type { ActivityFeedProps } from './types.js';

const KIND_ICON_PATHS: Record<ActivityItemKind, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  read: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  delegate:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  approval: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  wait: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  snag: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  done: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
};

function KindIcon({ kind }: { kind: ActivityItemKind }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
      // Icon paths are a static allowlist above; never user content.
      dangerouslySetInnerHTML={{ __html: KIND_ICON_PATHS[kind] }}
    />
  );
}

function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Plain-language, collapsible activity feed for a session.
 *
 * Replaces raw technical event dumps for everyday users: tool calls become
 * "Searched the web", approvals become "Asked for your approval", and
 * internal model/system events are omitted entirely. The technical timeline
 * stays available behind the container's view toggle.
 */
export function ActivityFeed({ segments, originMs, defaultExpanded = true }: ActivityFeedProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const items = useMemo(() => buildActivityItems(segments, originMs), [segments, originMs]);

  if (items.length === 0) return null;

  return (
    <div className="w-full" data-slot="activity-feed">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(previous => !previous)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs font-medium uppercase text-text-secondary">Activity</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={cn('size-3.5 text-text-secondary transition-transform', expanded && 'rotate-180')}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded && (
        <ul className="pb-2">
          {items.map(item => (
            <li key={item.id} className="flex items-start gap-3 px-3 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-background-secondary text-text-secondary">
                <KindIcon kind={item.kind} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-primary">{item.title}</span>
                {item.detail !== undefined && (
                  <span className="mt-0.5 block truncate text-xs text-text-secondary">{item.detail}</span>
                )}
              </span>
              <span className="shrink-0 pt-0.5 text-xs text-text-tertiary">{formatTime(item.timestampMs)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    ActivityFeed: ComponentType<ActivityFeedProps>;
  }
}
