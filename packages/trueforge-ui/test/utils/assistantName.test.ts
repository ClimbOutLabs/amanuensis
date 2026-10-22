import { describe, expect, it } from 'vitest';

import { assistantDisplayName } from '@/utils/assistantName.js';

describe('assistantDisplayName', () => {
  it('returns the name the person chose, trimmed', () => {
    expect(assistantDisplayName('  Maya ')).toBe('Maya');
  });

  it('falls back to Aman when no name is set', () => {
    expect(assistantDisplayName(null)).toBe('Aman');
    expect(assistantDisplayName(undefined)).toBe('Aman');
    expect(assistantDisplayName('   ')).toBe('Aman');
  });
});
