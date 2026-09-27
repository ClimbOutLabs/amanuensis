// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { formatRelativeTime, formatTokenCount } from '@/atoms/CompactionStatusLine.js';

describe('formatTokenCount', () => {
  it('formats sub-thousand counts as-is', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(800)).toBe('800');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats thousands with one decimal', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(8200)).toBe('8.2k');
    expect(formatTokenCount(12500)).toBe('12.5k');
  });

  it('rounds hundreds of thousands', () => {
    expect(formatTokenCount(128000)).toBe('128k');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-27T12:00:00Z').getTime();

  it('says just now for sub-minute ages', () => {
    expect(formatRelativeTime('2026-09-27T11:59:30Z', now)).toBe('just now');
  });

  it('formats minutes', () => {
    expect(formatRelativeTime('2026-09-27T11:30:00Z', now)).toBe('30m ago');
  });

  it('formats hours', () => {
    expect(formatRelativeTime('2026-09-27T10:00:00Z', now)).toBe('2h ago');
  });

  it('formats days', () => {
    expect(formatRelativeTime('2026-09-25T12:00:00Z', now)).toBe('2d ago');
  });

  it('returns empty for unparseable input', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});
