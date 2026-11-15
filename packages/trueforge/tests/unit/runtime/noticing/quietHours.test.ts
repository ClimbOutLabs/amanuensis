import { isQuietNow, startOfLocalDay } from '../../../../src/runtime/noticing/quietHours';

// 15:00 UTC is 11:00 in New York, outside the default quiet hours.
const DAYTIME = new Date('2026-11-05T15:00:00.000Z');
// 03:00 UTC is 22:00 the evening before in New York, inside quiet hours.
const NIGHT = new Date('2026-11-05T03:00:00.000Z');

describe('quiet hours', () => {
  const quiet = { enabled: true, start: '21:00', end: '08:00' };

  it('wraps midnight in the person’s zone', () => {
    expect(isQuietNow({ now: NIGHT, quiet, timezone: 'America/New_York' })).toBe(true);
    expect(isQuietNow({ now: DAYTIME, quiet, timezone: 'America/New_York' })).toBe(false);
    expect(isQuietNow({ now: DAYTIME, quiet, timezone: 'Asia/Tokyo' })).toBe(true);
  });

  it('is off when disabled or when start equals end', () => {
    expect(isQuietNow({ now: NIGHT, quiet: { ...quiet, enabled: false }, timezone: 'America/New_York' })).toBe(false);
    expect(isQuietNow({ now: NIGHT, quiet: { ...quiet, start: '09:00', end: '09:00' }, timezone: 'UTC' })).toBe(false);
  });

  it('handles a window inside one day', () => {
    const lunch = { enabled: true, start: '12:00', end: '13:00' };
    expect(isQuietNow({ now: new Date('2026-11-05T12:30:00.000Z'), quiet: lunch, timezone: 'UTC' })).toBe(true);
    expect(isQuietNow({ now: new Date('2026-11-05T13:00:00.000Z'), quiet: lunch, timezone: 'UTC' })).toBe(false);
  });

  it('finds the start of the local day', () => {
    expect(startOfLocalDay({ now: DAYTIME, timezone: 'America/New_York' }).toISOString()).toBe(
      '2026-11-05T05:00:00.000Z',
    );
  });
});
