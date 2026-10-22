import { DEFAULT_ASSISTANT_NAME } from '@truefoundry/trueforge-core/core/personas/assistantName';
import { describe, expect, it } from 'vitest';

import { assistantDisplayName } from '@/utils/assistantName.js';

describe('assistantDisplayName', () => {
  it('returns the name the person chose, trimmed', () => {
    expect(assistantDisplayName('  Maya ')).toBe('Maya');
  });

  it('falls back to the shared default name when no name is set', () => {
    expect(assistantDisplayName(null)).toBe(DEFAULT_ASSISTANT_NAME);
    expect(assistantDisplayName(undefined)).toBe(DEFAULT_ASSISTANT_NAME);
    expect(assistantDisplayName('   ')).toBe(DEFAULT_ASSISTANT_NAME);
  });

  it('is the same default the server prompt uses', () => {
    expect(DEFAULT_ASSISTANT_NAME).toBe('Aman');
  });
});
