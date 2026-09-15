import { FALLBACK_TIMEZONE, isValidTimezone, resolveLocalTime } from '../../../src/core/util/clientTimezone';

describe('isValidTimezone', () => {
  it('accepts a real IANA zone', () => {
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
  });

  it('rejects an unrecognized name', () => {
    expect(isValidTimezone('Not/A_Zone')).toBe(false);
  });
});

describe('resolveLocalTime', () => {
  // A fixed UTC instant: 2026-09-15T01:19:00.000Z.
  const now = new Date('2026-09-15T01:19:00.000Z');

  it('falls back to UTC when no timezone is supplied', () => {
    const local = resolveLocalTime(now, undefined);
    expect(local.isFallback).toBe(true);
    expect(local.zone).toBe(FALLBACK_TIMEZONE);
    expect(local.date).toBe('2026-09-15');
    expect(local.time).toBe('01:19:00');
    expect(local.utcOffset).toBe('+00:00');
  });

  it('falls back to UTC for an unrecognized timezone name', () => {
    const local = resolveLocalTime(now, 'Not/A_Zone');
    expect(local.isFallback).toBe(true);
    expect(local.zone).toBe(FALLBACK_TIMEZONE);
  });

  it('falls back to UTC for an empty string', () => {
    const local = resolveLocalTime(now, '');
    expect(local.isFallback).toBe(true);
    expect(local.zone).toBe(FALLBACK_TIMEZONE);
  });

  it('reports local date, time, zone and offset for a real IANA zone', () => {
    // America/Los_Angeles is UTC-7 in September (PDT).
    const local = resolveLocalTime(now, 'America/Los_Angeles');
    expect(local.isFallback).toBe(false);
    expect(local.zone).toBe('America/Los_Angeles');
    expect(local.date).toBe('2026-09-14');
    expect(local.time).toBe('18:19:00');
    expect(local.utcOffset).toBe('-07:00');
  });

  it('reports a positive offset for a zone ahead of UTC', () => {
    // Asia/Kolkata is UTC+5:30 year-round (no DST).
    const local = resolveLocalTime(now, 'Asia/Kolkata');
    expect(local.isFallback).toBe(false);
    expect(local.date).toBe('2026-09-15');
    expect(local.time).toBe('06:49:00');
    expect(local.utcOffset).toBe('+05:30');
  });
});
