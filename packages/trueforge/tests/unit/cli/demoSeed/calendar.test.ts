import {
  addDays,
  dayInZone,
  dayLabels,
  isValidTimeZone,
  isoDay,
  longDayLabel,
  parseIsoDay,
} from '../../../../src/cli/demoSeed/calendar';

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
    expect(longDayLabel({ year: 2026, month: 10, day: 15 })).toBe('Thursday, October 15');
  });

  it('validates zone names', () => {
    expect(isValidTimeZone('Europe/Lisbon')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('parseIsoDay', () => {
  it('reads a real day', () => {
    expect(parseIsoDay('2026-10-26')).toEqual({ year: 2026, month: 10, day: 26 });
    expect(parseIsoDay('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
  });

  it.each(['2026-02-30', '2026-13-01', '2027-02-29', '26-10-26', '2026-1-5', 'tomorrow', ''])('rejects %j', text => {
    expect(parseIsoDay(text)).toBeUndefined();
  });
});

describe('dayLabels', () => {
  const labels = dayLabels({ year: 2026, month: 10, day: 26 });

  it('names the days around the seed day by offset', () => {
    expect(labels.iso(0)).toBe('2026-10-26');
    expect(labels.weekday(0)).toBe('Monday');
    expect(labels.shortWeekday(1)).toBe('Tue');
    expect(labels.monthDay(1)).toBe('Oct 27');
    expect(labels.long(2)).toBe('Wednesday, October 28');
    expect(labels.longWithYear(2)).toBe('Wednesday, October 28, 2026');
    expect(labels.monthDay(10)).toBe('Nov 5');
    expect(labels.iso(-8)).toBe('2026-10-18');
  });
});
