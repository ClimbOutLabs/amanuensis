import {
  asksAboutPast,
  daysSinceEnd,
  endedBefore,
  endedRecently,
  lastDayOf,
} from '../../../../src/runtime/memory/statementDates';

describe('statement dates', () => {
  it('reads a partial date as its last day', () => {
    expect(lastDayOf('2026')).toBe('2026-12-31');
    expect(lastDayOf('2026-02')).toBe('2026-02-28');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
    expect(lastDayOf('2026-03-14')).toBe('2026-03-14');
  });

  it('has ended only when the end day is before today', () => {
    expect(endedBefore({ until: '2026-11-09', today: '2026-11-10' })).toBe(true);
    expect(endedBefore({ until: '2026-11-10', today: '2026-11-10' })).toBe(false);
    expect(endedBefore({ until: '2026-11', today: '2026-11-10' })).toBe(false);
  });

  it('counts the days since the end and treats 30 days as still recent', () => {
    expect(daysSinceEnd({ until: '2026-10-31', today: '2026-11-10' })).toBe(10);
    expect(endedRecently({ until: '2026-10-11', today: '2026-11-10' })).toBe(true);
    expect(endedRecently({ until: '2026-10-10', today: '2026-11-10' })).toBe(false);
  });

  it('notices a message that asks about the past', () => {
    expect(asksAboutPast('Where did we used to live?')).toBe(true);
    expect(asksAboutPast('What was the original plan')).toBe(true);
    expect(asksAboutPast('Does Zoe still swim?')).toBe(true);
    expect(asksAboutPast('Where do we live?')).toBe(false);
    expect(asksAboutPast('Who is the firstborn?')).toBe(false);
  });
});
