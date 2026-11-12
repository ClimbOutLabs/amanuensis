import { describe, expect, it } from 'vitest';

import {
  formatReminderWhen,
  groupReminders,
  reminderDetailLine,
  reminderWhenLine,
} from '@/reminders/groupReminders.js';
import type { ReminderItem } from '@/reminders/types.js';

function item(overrides: Partial<ReminderItem>): ReminderItem {
  return {
    id: 'reminder-1',
    what: 'Take the bins out',
    timezone: 'America/Los_Angeles',
    repeats: false,
    timing: 'Once, on Wednesday, November 4 at 9:00 AM',
    state: 'upcoming',
    nextDueAt: '2026-11-04T17:00:00.000Z',
    lastRemindedAt: null,
    lastDueAt: null,
    setAt: '2026-11-01T09:00:00.000Z',
    personaName: 'Mannie',
    sessionId: null,
    ...overrides,
  };
}

describe('groupReminders', () => {
  it('puts upcoming and paused in Coming up, reminded and missed in Already reminded', () => {
    const groups = groupReminders([
      item({ id: 'a', state: 'upcoming' }),
      item({ id: 'b', state: 'paused', nextDueAt: null }),
      item({ id: 'c', state: 'reminded', nextDueAt: null, lastRemindedAt: '2026-11-02T17:00:00.000Z' }),
      item({ id: 'd', state: 'missed', nextDueAt: null, lastDueAt: '2026-11-02T12:00:00.000Z' }),
    ]);
    expect(groups.comingUp.map(entry => entry.id)).toEqual(['a', 'b']);
    expect(groups.alreadyReminded.map(entry => entry.id)).toEqual(['c', 'd']);
  });

  it('keeps a reminder due at this very moment in Coming up', () => {
    const now = '2026-11-03T17:00:00.000Z';
    const groups = groupReminders([
      item({ id: 'due-now', state: 'upcoming', nextDueAt: now }),
      item({ id: 'just-fired', state: 'reminded', nextDueAt: null, lastRemindedAt: now, lastDueAt: now }),
    ]);
    expect(groups.comingUp.map(entry => entry.id)).toEqual(['due-now']);
    expect(groups.alreadyReminded.map(entry => entry.id)).toEqual(['just-fired']);
  });

  it('orders Coming up soonest first, with no due time last', () => {
    const groups = groupReminders([
      item({ id: 'later', nextDueAt: '2026-11-06T17:00:00.000Z' }),
      item({ id: 'paused', state: 'paused', nextDueAt: null }),
      item({ id: 'sooner', nextDueAt: '2026-11-04T17:00:00.000Z' }),
    ]);
    expect(groups.comingUp.map(entry => entry.id)).toEqual(['sooner', 'later', 'paused']);
  });

  it('orders Already reminded newest first, by when it fired or was due', () => {
    const groups = groupReminders([
      item({ id: 'older', state: 'reminded', nextDueAt: null, lastRemindedAt: '2026-11-01T17:00:00.000Z' }),
      item({ id: 'missed', state: 'missed', nextDueAt: null, lastDueAt: '2026-11-03T12:00:00.000Z' }),
      item({ id: 'newer', state: 'reminded', nextDueAt: null, lastRemindedAt: '2026-11-02T17:00:00.000Z' }),
    ]);
    expect(groups.alreadyReminded.map(entry => entry.id)).toEqual(['missed', 'newer', 'older']);
  });
});

describe('reminder lines', () => {
  it('formats a due time in the reminder time zone', () => {
    expect(formatReminderWhen('2026-11-04T17:00:00.000Z', 'America/Los_Angeles')).toBe(
      'Wednesday, November 4 at 9:00 AM',
    );
  });

  it('says when an upcoming reminder is due', () => {
    expect(reminderWhenLine(item({}))).toBe('Wednesday, November 4 at 9:00 AM');
  });

  it('says when a past reminder fired', () => {
    expect(
      reminderWhenLine(item({ state: 'reminded', nextDueAt: null, lastRemindedAt: '2026-11-02T17:00:00.000Z' })),
    ).toBe('Reminded Monday, November 2 at 9:00 AM');
  });

  it('says a missed reminder did not go through, without blaming anyone', () => {
    expect(reminderWhenLine(item({ state: 'missed', nextDueAt: null, lastDueAt: '2026-11-02T12:00:00.000Z' }))).toBe(
      'Was due Monday, November 2 at 4:00 AM. It did not go through.',
    );
  });

  it('labels a paused reminder and keeps its timing words', () => {
    expect(reminderWhenLine(item({ state: 'paused', nextDueAt: null, timing: 'Every day at 9:00 AM' }))).toBe(
      'Paused. Every day at 9:00 AM',
    );
  });

  it('names the persona and the day it was set', () => {
    expect(reminderDetailLine(item({}))).toBe('Set with Mannie on November 1, 2026.');
  });

  it('adds the last firing to a repeating reminder that is still coming up', () => {
    expect(reminderDetailLine(item({ repeats: true, lastRemindedAt: '2026-11-03T17:00:00.000Z' }))).toBe(
      'Set with Mannie on November 1, 2026. Last reminded November 3, 2026.',
    );
  });
});
