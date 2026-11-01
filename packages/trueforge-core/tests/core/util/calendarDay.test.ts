import { addDays, isoDay, parseDateOnly, weekdayOf } from '../../../src/core/util/calendarDay';
import { utcOffsetMinutes } from '../../../src/core/util/clientTimezone';

describe('calendar days', () => {
  it('adds days across month and year ends', () => {
    expect(isoDay(addDays({ day: { year: 2026, month: 10, day: 30 }, days: 3 }))).toBe('2026-11-02');
    expect(isoDay(addDays({ day: { year: 2026, month: 12, day: 30 }, days: 5 }))).toBe('2027-01-04');
  });

  it('parses only dates that exist', () => {
    expect(parseDateOnly('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseDateOnly('2026-02-30')).toBeUndefined();
    expect(parseDateOnly('2026-2-3')).toBeUndefined();
    expect(parseDateOnly('2026-10-19T00:00:00Z')).toBeUndefined();
  });

  it('numbers the weekday from Sunday', () => {
    expect(weekdayOf({ year: 2026, month: 10, day: 18 })).toBe(0);
    expect(weekdayOf({ year: 2026, month: 10, day: 17 })).toBe(6);
  });
});

describe('utcOffsetMinutes', () => {
  it('follows the zone, half-hour zones and clock changes', () => {
    expect(utcOffsetMinutes({ instant: new Date('2026-10-19T12:00:00Z'), zone: 'America/Sao_Paulo' })).toBe(-180);
    expect(utcOffsetMinutes({ instant: new Date('2026-10-19T12:00:00Z'), zone: 'Asia/Kolkata' })).toBe(330);
    expect(utcOffsetMinutes({ instant: new Date('2026-07-01T12:00:00Z'), zone: 'Europe/Madrid' })).toBe(120);
    expect(utcOffsetMinutes({ instant: new Date('2026-12-01T12:00:00Z'), zone: 'Europe/Madrid' })).toBe(60);
  });
});
