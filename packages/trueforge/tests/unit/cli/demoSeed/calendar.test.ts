import {
  addDays,
  clockLabel,
  dayInZone,
  isValidTimeZone,
  isoDay,
  longDayLabel,
} from '../../../../src/cli/demoSeed/calendar';

describe('calendar', () => {
  it('reads today in the target zone, not in UTC', () => {
    const now = new Date('2026-10-14T23:30:00Z');
    expect(isoDay(dayInZone({ now, timeZone: 'UTC' }))).toBe('2026-10-14');
    expect(isoDay(dayInZone({ now, timeZone: 'Europe/Madrid' }))).toBe('2026-10-15');
    expect(isoDay(dayInZone({ now, timeZone: 'America/Los_Angeles' }))).toBe('2026-10-14');
  });

  it('adds days across month and year ends', () => {
    expect(isoDay(addDays({ day: { year: 2026, month: 10, day: 30 }, days: 3 }))).toBe('2026-11-02');
    expect(isoDay(addDays({ day: { year: 2026, month: 12, day: 30 }, days: 5 }))).toBe('2027-01-04');
  });

  it('labels a day with its weekday', () => {
    expect(longDayLabel({ year: 2026, month: 10, day: 15 })).toBe('Thursday, October 15');
  });

  it('formats clock labels', () => {
    expect(clockLabel({ hour: 16, minute: 0 })).toBe('4:00 pm');
    expect(clockLabel({ hour: 0, minute: 5 })).toBe('12:05 am');
    expect(clockLabel({ hour: 12, minute: 30 })).toBe('12:30 pm');
  });

  it('validates zone names', () => {
    expect(isValidTimeZone('Europe/Madrid')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
