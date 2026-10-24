import { isoDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import { isValidTimezone } from '@truefoundry/trueforge-core/core/util/clientTimezone';
import {
  addDays,
  dayInZone,
  dayLabels,
  parseDemoDay,
  STORY,
  weekdayOffset,
} from '../../../../src/cli/demoSeed/storyDays.mjs';

describe('calendar', () => {
  it('reads today in the target zone, not in UTC', () => {
    const now = new Date('2026-10-14T23:30:00Z');
    expect(isoDay(dayInZone({ now, timeZone: 'UTC' }))).toBe('2026-10-14');
    expect(isoDay(dayInZone({ now, timeZone: 'Europe/Lisbon' }))).toBe('2026-10-15');
    expect(isoDay(dayInZone({ now, timeZone: 'Europe/Madrid' }))).toBe('2026-10-15');
    expect(isoDay(dayInZone({ now, timeZone: 'America/Los_Angeles' }))).toBe('2026-10-14');
  });

  it('adds days across month and year ends', () => {
    expect(isoDay(addDays({ day: { year: 2026, month: 10, day: 30 }, days: 3 }))).toBe('2026-11-02');
    expect(isoDay(addDays({ day: { year: 2026, month: 12, day: 30 }, days: 5 }))).toBe('2027-01-04');
    expect(isoDay(addDays({ day: { year: 2026, month: 10, day: 26 }, days: -17 }))).toBe('2026-10-09');
  });

  it('labels a day with its weekday', () => {
    expect(dayLabels({ year: 2026, month: 10, day: 15 }).long(0)).toBe('Thursday, October 15');
    expect(dayLabels({ year: 2026, month: 12, day: 31 }).longYear(3)).toBe('Sunday, January 3, 2027');
  });

  it('reads only real days written YYYY-MM-DD', () => {
    expect(parseDemoDay('2026-10-19')).toEqual({ year: 2026, month: 10, day: 19 });
    expect(() => parseDemoDay('2026-02-30')).toThrow('is not a real calendar day');
    expect(() => parseDemoDay('19/10/2026')).toThrow('is not a day written YYYY-MM-DD');
  });

  it('validates zone names', () => {
    expect(isValidTimezone('Europe/Lisbon')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('dayLabels', () => {
  const labels = dayLabels({ year: 2026, month: 10, day: 26 });

  it('names the days around the seed day by offset', () => {
    expect(labels.weekday(0)).toBe('Monday');
    expect(labels.monthDay(1)).toBe('Oct 27');
    expect(labels.long(2)).toBe('Wednesday, October 28');
    expect(labels.monthDay(10)).toBe('Nov 5');
  });
});

describe('weekdayOffset', () => {
  // The GP visit sits three days after today, moved on to Monday when that day is a weekend.
  const visitOffsetOn = (today: { year: number; month: number; day: number }): number =>
    weekdayOffset({ today, offset: STORY.GP_VISIT_EARLIEST });

  it.each([
    ['Monday', 19, 3, 'Thursday'],
    ['Tuesday', 20, 3, 'Friday'],
    ['Wednesday', 21, 5, 'Monday'],
    ['Thursday', 22, 4, 'Monday'],
    ['Friday', 23, 3, 'Monday'],
    ['Saturday', 24, 3, 'Tuesday'],
    ['Sunday', 25, 3, 'Wednesday'],
  ])('puts the GP visit on a weekday when today is a %s', (_name, dayOfMonth, offset, visitWeekday) => {
    const today = { year: 2026, month: 10, day: dayOfMonth };
    expect(visitOffsetOn(today)).toBe(offset);
    expect(dayLabels(today).weekday(offset)).toBe(visitWeekday);
  });

  it('never lands a visit on a weekend, on any day of the week', () => {
    for (let dayOfMonth = 19; dayOfMonth <= 25; dayOfMonth += 1) {
      const today = { year: 2026, month: 10, day: dayOfMonth };
      const offset = visitOffsetOn(today);
      expect(offset).toBeGreaterThanOrEqual(STORY.GP_VISIT_EARLIEST);
      expect(['Saturday', 'Sunday']).not.toContain(dayLabels(today).weekday(offset));
    }
  });
});
