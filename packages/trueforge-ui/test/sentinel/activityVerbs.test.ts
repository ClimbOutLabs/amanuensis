import { describe, expect, it } from 'vitest';

import { ACTIVITY_STATE_LABELS, activityStateOf, receiptRowsOf } from '@/sentinel/activityVerbs.js';
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

describe('activityStateOf', () => {
  it('maps each audit outcome to one of the five state words', () => {
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'approved', tier: 3 }))]).toBe('Approved');
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'denied', tier: 3 }))]).toBe('Declined');
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'auto_denied', tier: 3 }))]).toBe('Blocked');
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'ran', tier: 2 }))]).toBe('Allowed by your settings');
  });

  it('splits a logged row by tier: a read the settings allow is allowed, a held call is waiting for you', () => {
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'logged', tier: 1 }))]).toBe(
      'Allowed by your settings',
    );
    expect(ACTIVITY_STATE_LABELS[activityStateOf(entry({ outcome: 'logged', tier: 2 }))]).toBe('Waiting for you');
  });
});

describe('receiptRowsOf', () => {
  it('folds entries that share a verb and a state into one row', () => {
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
  });

  it('reads a feed line for an unnamed persona check and switch as a persona, never a specialist', () => {
    const rows = receiptRowsOf([
      entry({ id: '1', action_type: 'persona_read', outcome: 'ran', created_at: '2026-10-21T08:00:00.000Z' }),
      entry({ id: '2', action_type: 'use_persona', outcome: 'ran', created_at: '2026-10-21T09:00:00.000Z' }),
      entry({ id: '3', action_type: 'list_personas', outcome: 'ran', created_at: '2026-10-21T10:00:00.000Z' }),
    ]);
    expect(rows.map(row => row.verb)).toEqual(['Checked a persona', 'Switched persona']);
    for (const row of rows) expect(row.verb).not.toMatch(/specialist/i);
  });

  it('keeps schedule lines about schedules, with no persona wording', () => {
    const rows = receiptRowsOf([
      entry({ id: '1', action_type: 'list_schedules', outcome: 'ran', created_at: '2026-10-21T08:00:00.000Z' }),
      entry({ id: '2', action_type: 'create_schedule', outcome: 'ran', created_at: '2026-10-21T09:00:00.000Z' }),
    ]);
    expect(rows.map(row => row.verb)).toEqual(['Changed a schedule', 'Checked a schedule']);
  });

  it('lists the newest row first', () => {
    const rows = receiptRowsOf([
      entry({ id: '1', action_type: 'exec', outcome: 'ran', created_at: '2026-10-21T08:00:00.000Z' }),
      entry({ id: '2', action_type: 'web_search', outcome: 'ran', created_at: '2026-10-21T10:00:00.000Z' }),
    ]);
    expect(rows.map(row => row.verb)).toEqual(['Searched the web', 'Ran a command']);
  });
});
