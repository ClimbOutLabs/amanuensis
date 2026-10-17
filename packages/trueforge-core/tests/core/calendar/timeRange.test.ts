import { resolveBounds, shiftDate } from '../../../src/core/calendar/timeRange';
import { ListEventsSchema } from '../../../src/core/calendar/toolContract';
import { isRealDate, weekdayNameOf } from '../../../src/core/util/calendarDay';

describe('resolveBounds', () => {
  it('begins a start date at midnight in the zone and ends an end date after that whole day', () => {
    expect(resolveBounds({ time_min: '2026-10-19', time_max: '2026-10-19', zone: 'America/Sao_Paulo' })).toEqual({
      ok: true,
      timeMin: '2026-10-19T03:00:00.000Z',
      timeMax: '2026-10-20T03:00:00.000Z',
    });
    expect(resolveBounds({ time_min: '2026-10-19', time_max: '2026-10-19', zone: 'Asia/Tokyo' })).toEqual({
      ok: true,
      timeMin: '2026-10-18T15:00:00.000Z',
      timeMax: '2026-10-19T15:00:00.000Z',
    });
  });

  it('follows a clock change: the day Europe leaves summer time lasts 25 hours', () => {
    const bounds = resolveBounds({ time_min: '2026-10-25', time_max: '2026-10-25', zone: 'Europe/Madrid' });
    expect(bounds).toEqual({ ok: true, timeMin: '2026-10-24T22:00:00.000Z', timeMax: '2026-10-25T23:00:00.000Z' });
  });

  it('keeps a half-hour zone exact', () => {
    expect(resolveBounds({ time_min: '2026-10-19', time_max: '2026-10-19', zone: 'Asia/Kolkata' })).toEqual({
      ok: true,
      timeMin: '2026-10-18T18:30:00.000Z',
      timeMax: '2026-10-19T18:30:00.000Z',
    });
  });

  it('refuses an empty, backwards or very wide range', () => {
    expect(resolveBounds({ time_min: '2026-10-20T10:00:00Z', time_max: '2026-10-20T10:00:00Z', zone: 'UTC' }).ok).toBe(
      false,
    );
    expect(resolveBounds({ time_min: '2026-10-20', time_max: '2026-10-01', zone: 'UTC' }).ok).toBe(false);
    expect(resolveBounds({ time_min: '2026-01-01', time_max: '2027-12-31', zone: 'UTC' }).ok).toBe(false);
  });
});

describe('days', () => {
  it('steps back one day across a month and a year', () => {
    expect(shiftDate({ date: '2026-11-01', days: -1 })).toBe('2026-10-31');
    expect(shiftDate({ date: '2027-01-01', days: -1 })).toBe('2026-12-31');
  });

  it('names the weekday of a calendar date, and tells a date from a moment', () => {
    expect(weekdayNameOf('2026-10-19')).toBe('Monday');
    expect(isRealDate('2026-10-19')).toBe(true);
    expect(isRealDate('2026-10-19T00:00:00Z')).toBe(false);
  });
});

describe('list_events parameters', () => {
  const ok = (value: unknown) => ListEventsSchema.safeParse(value).success;

  it('takes a real date or a moment with an offset, and nothing else', () => {
    expect(ok({ time_min: '2026-10-19', time_max: '2026-10-26' })).toBe(true);
    expect(ok({ time_min: '2026-10-19T09:00:00-03:00', time_max: '2026-10-19T18:00:00Z' })).toBe(true);
    expect(ok({ time_min: '2026-02-30', time_max: '2026-03-02' })).toBe(false);
    expect(ok({ time_min: 'next week', time_max: '2026-10-26' })).toBe(false);
    expect(ok({ time_min: '2026-10-19T09:00:00', time_max: '2026-10-26' })).toBe(false);
    expect(ok({ time_min: '2026-10-19', time_max: '2026-10-26', calendar_id: 'other' })).toBe(false);
  });

  it('knows a real day from one that rolls over', () => {
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
  });
});
