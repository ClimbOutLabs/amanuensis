import { describe, expect, it } from 'vitest';

import { formatGoalTarget } from '@/goals/goalAttention.js';
import { targetInstant, targetWallParts } from '@/goals/goalTargetTime.js';

describe('target wall clock conversions', () => {
  it('reads an instant as the wall date and time in the goal zone', () => {
    // 1 AM UTC on December 21 is 5 PM on December 20 in Los Angeles.
    expect(targetWallParts({ iso: '2026-12-21T01:00:00.000Z', timezone: 'America/Los_Angeles' })).toEqual({
      date: '2026-12-20',
      time: '17:00',
    });
  });

  it('writes a wall date and time in the goal zone back to the same instant', () => {
    expect(targetInstant({ date: '2026-12-20', time: '17:00', timezone: 'America/Los_Angeles' })).toBe(
      '2026-12-21T01:00:00.000Z',
    );
  });

  it('writes the start of a date in the goal zone, not in UTC', () => {
    // Midnight at the start of December 20 in Los Angeles is 8 AM UTC.
    expect(targetInstant({ date: '2026-12-20', time: '00:00', timezone: 'America/Los_Angeles' })).toBe(
      '2026-12-20T08:00:00.000Z',
    );
  });

  it('round trips a wall time on a daylight saving change day', () => {
    // March 8, 2026 is the spring clock change in Los Angeles. 9 AM exists.
    const instant = targetInstant({ date: '2026-03-08', time: '09:00', timezone: 'America/Los_Angeles' });
    expect(instant).toBe('2026-03-08T16:00:00.000Z');
    expect(targetWallParts({ iso: instant, timezone: 'America/Los_Angeles' })).toEqual({
      date: '2026-03-08',
      time: '09:00',
    });
  });

  it('falls back to UTC for a zone it does not know', () => {
    expect(targetInstant({ date: '2026-12-20', time: '17:00', timezone: 'Not/AZone' })).toBe(
      '2026-12-20T17:00:00.000Z',
    );
    expect(targetWallParts({ iso: '2026-12-20T17:00:00.000Z', timezone: 'Not/AZone' })).toEqual({
      date: '2026-12-20',
      time: '17:00',
    });
  });

  it('returns null for a value that is not a date', () => {
    expect(targetWallParts({ iso: 'not a date', timezone: 'America/Los_Angeles' })).toBeNull();
  });
});

describe('formatGoalTarget', () => {
  it('shows the date alone when the target carries no time', () => {
    expect(formatGoalTarget({ iso: '2027-03-15T09:00:00.000Z', hasTime: false, timezone: 'America/Los_Angeles' })).toBe(
      'March 15, 2027',
    );
  });

  it('shows the date and time when the target carries a time', () => {
    expect(formatGoalTarget({ iso: '2026-12-21T01:00:00.000Z', hasTime: true, timezone: 'America/Los_Angeles' })).toBe(
      'December 20, 2026 at 5:00 PM',
    );
  });

  it('keeps a midnight the person picked as a time', () => {
    expect(formatGoalTarget({ iso: '2026-12-20T08:00:00.000Z', hasTime: true, timezone: 'America/Los_Angeles' })).toBe(
      'December 20, 2026 at 12:00 AM',
    );
  });
});
