import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_SUBTITLES,
  activityRowOf,
  activityTitleOf,
  groupActivityRows,
  relativeTimeLabel,
} from '@/sentinel/activityVerbs.js';
import type { SentinelAuditEntry } from '@/sentinel/types.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');

function entry(overrides: Partial<SentinelAuditEntry>): SentinelAuditEntry {
  return {
    id: 'entry',
    session_id: 'session-1',
    created_at: NOW.toISOString(),
    tier: 2,
    action_type: 'web_search',
    description: '',
    outcome: 'ran',
    ...overrides,
  };
}

const minutesBefore = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe('activityTitleOf', () => {
  it('names the real service and what it did', () => {
    expect(activityTitleOf('gmail_read')).toBe('Gmail · read email');
    expect(activityTitleOf('web_search')).toBe('Web search · searched the web');
  });

  it('falls back to the tool name in sentence case, never connected app', () => {
    expect(activityTitleOf('some_new_tool')).toBe('Some new tool');
    expect(activityTitleOf('some_new_tool')).not.toMatch(/connected app/i);
  });
});

describe('activityRowOf', () => {
  it('gives each audit outcome its mark and one subtitle', () => {
    const rows = {
      ran: activityRowOf(entry({ outcome: 'ran' })),
      approved: activityRowOf(entry({ outcome: 'approved', tier: 3 })),
      denied: activityRowOf(entry({ outcome: 'denied', tier: 3 })),
      autoDenied: activityRowOf(entry({ outcome: 'auto_denied', tier: 3 })),
      readRan: activityRowOf(entry({ outcome: 'logged', tier: 1 })),
      held: activityRowOf(entry({ outcome: 'logged', tier: 2 })),
    };
    expect([rows.ran.subtitle, rows.ran.mark]).toEqual([ACTIVITY_SUBTITLES.doneAllowed, '✓']);
    expect([rows.approved.subtitle, rows.approved.mark]).toEqual([ACTIVITY_SUBTITLES.approved, '✓']);
    expect([rows.denied.subtitle, rows.denied.mark]).toEqual([ACTIVITY_SUBTITLES.declined, '–']);
    expect([rows.autoDenied.subtitle, rows.autoDenied.mark]).toEqual(['Failed: blocked by your settings', '!']);
    expect([rows.readRan.subtitle, rows.readRan.mark]).toEqual([ACTIVITY_SUBTITLES.doneAllowed, '✓']);
    expect([rows.held.subtitle, rows.held.mark]).toEqual([ACTIVITY_SUBTITLES.waiting, '·']);
  });

  it('marks only an auto-denied row as failed', () => {
    expect(activityRowOf(entry({ outcome: 'auto_denied', tier: 3 })).failed).toBe(true);
    expect(activityRowOf(entry({ outcome: 'denied', tier: 3 })).failed).toBe(false);
  });
});

describe('groupActivityRows', () => {
  it('keeps rows less than ten minutes apart in one reply, newest first', () => {
    const groups = groupActivityRows({
      entries: [entry({ id: 'old', created_at: minutesBefore(8) }), entry({ id: 'new', created_at: minutesBefore(1) })],
      now: NOW,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('This reply');
    expect(groups[0]?.rows.map(row => row.id)).toEqual(['new', 'old']);
  });

  it('starts a new group after a quiet gap, labelled by when it happened', () => {
    const groups = groupActivityRows({
      entries: [
        entry({ id: 'now', created_at: minutesBefore(1) }),
        entry({ id: 'earlier', created_at: minutesBefore(3 * 24 * 60) }),
      ],
      now: NOW,
    });
    expect(groups.map(group => group.label)).toEqual(['This reply', 'Earlier']);
  });

  it('does not call an old reply This reply, even when it is the newest', () => {
    const groups = groupActivityRows({ entries: [entry({ created_at: minutesBefore(45) })], now: NOW });
    expect(groups[0]?.label).not.toBe('This reply');
  });

  it('returns no groups for an empty chat', () => {
    expect(groupActivityRows({ entries: [], now: NOW })).toEqual([]);
  });
});

describe('relativeTimeLabel', () => {
  it('reads elapsed time in one short phrase', () => {
    expect(relativeTimeLabel({ iso: minutesBefore(0), now: NOW })).toBe('just now');
    expect(relativeTimeLabel({ iso: minutesBefore(2), now: NOW })).toBe('2m ago');
    expect(relativeTimeLabel({ iso: minutesBefore(150), now: NOW })).toBe('2h ago');
    expect(relativeTimeLabel({ iso: minutesBefore(3 * 24 * 60), now: NOW })).toBe('3d ago');
  });
});
