import { describe, expect, it } from 'vitest';

import { dayPartForHour, msUntilNextDayPart } from '@/theme/dayPart.js';

describe('dayPartForHour', () => {
  it('maps 05 to 11 to morning, 11 to 17 to midday, and the rest to evening', () => {
    expect(dayPartForHour(4)).toBe('evening');
    expect(dayPartForHour(5)).toBe('morning');
    expect(dayPartForHour(10)).toBe('morning');
    expect(dayPartForHour(11)).toBe('midday');
    expect(dayPartForHour(16)).toBe('midday');
    expect(dayPartForHour(17)).toBe('evening');
    expect(dayPartForHour(23)).toBe('evening');
    expect(dayPartForHour(0)).toBe('evening');
  });
});

describe('msUntilNextDayPart', () => {
  it('counts to the next band start on the same day', () => {
    expect(msUntilNextDayPart(new Date(2026, 9, 21, 10, 30))).toBe(30 * 60_000);
    expect(msUntilNextDayPart(new Date(2026, 9, 21, 16, 0))).toBe(60 * 60_000);
  });

  it('counts to 05 the next morning once the evening band has started', () => {
    expect(msUntilNextDayPart(new Date(2026, 9, 21, 17, 0))).toBe(12 * 60 * 60_000);
    expect(msUntilNextDayPart(new Date(2026, 9, 21, 23, 0))).toBe(6 * 60 * 60_000);
  });

  it('never returns zero on a boundary, so a timer re-arms onto the next band', () => {
    expect(msUntilNextDayPart(new Date(2026, 9, 21, 11, 0))).toBe(6 * 60 * 60_000);
  });
});
