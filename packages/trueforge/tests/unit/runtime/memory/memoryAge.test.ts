import { memoryAge } from '../../../../src/runtime/memory/memoryAge';

describe('memoryAge', () => {
  const today = '2026-11-13';
  const age = (day: string) => memoryAge({ day, today });

  it('names today and yesterday', () => {
    expect(age('2026-11-13')).toBe('today');
    expect(age('2026-11-12')).toBe('yesterday');
  });

  it('counts days for under two weeks, then weeks for under two months', () => {
    expect(age('2026-11-11')).toBe('2 days ago');
    expect(age('2026-10-31')).toBe('13 days ago');
    expect(age('2026-10-30')).toBe('2 weeks ago');
    expect(age('2026-09-14')).toBe('8 weeks ago');
  });

  it('counts whole months for under two years, then whole years', () => {
    expect(age('2026-09-13')).toBe('2 months ago');
    expect(age('2025-11-14')).toBe('11 months ago');
    expect(age('2025-11-13')).toBe('12 months ago');
    expect(age('2024-11-14')).toBe('23 months ago');
    expect(age('2024-11-13')).toBe('2 years ago');
    expect(age('2016-03-01')).toBe('10 years ago');
  });

  it('says nothing for a day after today or a day it cannot read', () => {
    expect(age('2026-11-14')).toBeUndefined();
    expect(age('undated')).toBeUndefined();
    expect(age('2026-02-31')).toBeUndefined();
    expect(memoryAge({ day: '2026-11-01', today: 'soon' })).toBeUndefined();
  });
});
