import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_FALLBACK_VERB,
  ACTIVITY_STATE_LABELS,
  activityStateOf,
  activityVerbOf,
  plainAuditReason,
  receiptRowsOf,
} from '@/sentinel/activityVerbs.js';
import type { SentinelAuditEntry } from '@/sentinel/types.js';

function entry(overrides: Partial<SentinelAuditEntry>): SentinelAuditEntry {
  return {
    id: 'entry',
    session_id: 'session-1',
    created_at: '2026-10-21T09:00:00.000Z',
    tier: 1,
    action_type: 'gmail_read',
    description: '',
    outcome: 'logged',
    ...overrides,
  };
}

describe('activityVerbOf', () => {
  it('reads a known tool as a plain verb phrase', () => {
    expect(activityVerbOf('web_search')).toBe('Searched the web');
    expect(activityVerbOf('gmail_read')).toBe('Read your email');
  });

  it('falls back to a plain phrase, never the raw tool name', () => {
    expect(activityVerbOf('some_new_tool')).toBe(ACTIVITY_FALLBACK_VERB);
  });
});

describe('activityStateOf', () => {
  it('maps each audit outcome to one of the five state words', () => {
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'approved', tier: 3 }))]).toBe('You approved');
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'denied', tier: 3 }))]).toBe('You declined');
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'auto_denied', tier: 3 }))]).toBe(
      'Turned down automatically',
    );
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'ran', tier: 2 }))]).toBe(
      'Done · allowed by your settings',
    );
  });

  it('splits a logged row by tier: a read the settings allow is allowed, a held call is waiting for you', () => {
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'logged', tier: 1 }))]).toBe(
      'Done · allowed by your settings',
    );
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'logged', tier: 2 }))]).toBe('Waiting for you');
  });
});

describe('receiptRowsOf', () => {
  it('counts entries that share a verb and a state into one row', () => {
    const rows = receiptRowsOf([
      entry({ id: '1', created_at: '2026-10-21T09:00:00.000Z' }),
      entry({ id: '2', created_at: '2026-10-21T09:05:00.000Z' }),
      entry({ id: '3', created_at: '2026-10-21T09:02:00.000Z' }),
    ]);
    expect(rows).toEqual([
      {
        key: 'allowed:Read your email',
        verb: 'Read your email',
        state: 'allowed',
        count: 3,
        latestAt: '2026-10-21T09:05:00.000Z',
      },
    ]);
  });

  it('keeps the same verb apart when the state differs', () => {
    const rows = receiptRowsOf([
      entry({ id: '1', action_type: 'gmail_send', outcome: 'approved', tier: 3 }),
      entry({ id: '2', action_type: 'gmail_send', outcome: 'denied', tier: 3 }),
    ]);
    expect(rows.map(row => row.state)).toEqual(['approved', 'declined']);
    expect(rows.map(row => row.count)).toEqual([1, 1]);
  });

  it('lists the newest row first', () => {
    const rows = receiptRowsOf([
      entry({ id: '1', action_type: 'exec', outcome: 'ran', created_at: '2026-10-21T08:00:00.000Z' }),
      entry({ id: '2', action_type: 'web_search', outcome: 'ran', created_at: '2026-10-21T10:00:00.000Z' }),
    ]);
    expect(rows.map(row => row.verb)).toEqual(['Searched the web', 'Ran a command']);
  });
});

describe('plainAuditReason', () => {
  it('turns the machine reasons into plain words', () => {
    expect(plainAuditReason('outbound_guard')).toBe('it carries something that must not leave this computer');
    expect(plainAuditReason('offline_mode')).toBe('Offline mode is on');
    expect(plainAuditReason('destination_unverifiable')).toBe('Aman could not check where it would go');
    expect(plainAuditReason('unattended_run')).toBe('no one was there to ask');
  });

  it('leaves a reason that is already plain words as it is', () => {
    expect(plainAuditReason('User declined.')).toBe('User declined.');
  });
});
