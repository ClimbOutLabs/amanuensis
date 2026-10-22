import { describe, expect, it } from 'vitest';

import { dayPartForHour } from '@/theme/dayPart.js';

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
