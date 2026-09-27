import { describe, expect, it } from 'vitest';

import { normalizeProseTypography } from '@/utils/normalizeProseTypography.js';

describe('normalizeProseTypography', () => {
  it('replaces U+2011 non-breaking hyphen with an ASCII hyphen', () => {
    expect(normalizeProseTypography('large‑scale')).toBe('large-scale');
  });

  it('replaces U+2010 hyphen with an ASCII hyphen', () => {
    expect(normalizeProseTypography('co‐author')).toBe('co-author');
  });

  it('replaces U+00A0 no-break space with a normal space', () => {
    expect(normalizeProseTypography('10 MB')).toBe('10 MB');
  });

  it('replaces U+202F narrow no-break space with a normal space', () => {
    expect(normalizeProseTypography('12 am')).toBe('12 am');
  });

  it('leaves em dashes, en dashes, and curly quotes untouched', () => {
    const text = 'a — b, a – b, “quoted”';
    expect(normalizeProseTypography(text)).toBe(text);
  });

  it('leaves plain ASCII text unchanged', () => {
    const text = 'nothing to normalize here - just a plain hyphen and space';
    expect(normalizeProseTypography(text)).toBe(text);
  });

  it('handles multiple occurrences in one string', () => {
    expect(normalizeProseTypography('a‑b‑c d e')).toBe('a-b-c d e');
  });
});
