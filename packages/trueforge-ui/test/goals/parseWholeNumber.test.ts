import { describe, expect, it } from 'vitest';

import { parseWholeNumber } from '@/goals/parseWholeNumber.js';

describe('parseWholeNumber', () => {
  it('reads plain digits as written', () => {
    expect(parseWholeNumber('1000000')).toBe(1_000_000);
    expect(parseWholeNumber('24')).toBe(24);
    expect(parseWholeNumber('0')).toBe(0);
  });

  it('reads comma-grouped digits at their full value', () => {
    expect(parseWholeNumber('1,000,000')).toBe(1_000_000);
    expect(parseWholeNumber('300,000')).toBe(300_000);
    expect(parseWholeNumber('2,000')).toBe(2_000);
  });

  it('refuses anything that is not one whole number', () => {
    expect(parseWholeNumber('10x00')).toBeNull();
    expect(parseWholeNumber('')).toBeNull();
    expect(parseWholeNumber('1,00')).toBeNull();
    expect(parseWholeNumber('1,0000')).toBeNull();
    expect(parseWholeNumber('1000,000')).toBeNull();
    expect(parseWholeNumber('-5')).toBeNull();
    expect(parseWholeNumber('1.5')).toBeNull();
    expect(parseWholeNumber('1 000 000')).toBeNull();
  });
});
