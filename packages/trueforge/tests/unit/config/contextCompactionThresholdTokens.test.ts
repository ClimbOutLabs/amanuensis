import { DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS } from '@truefoundry/trueforge-core/core';

import { parsePositiveInt } from '../../../src/config';

describe('CONTEXT_COMPACTION_THRESHOLD_TOKENS env parsing', () => {
  it('falls back to the shared default when unset', () => {
    const value = parsePositiveInt({
      envKey: 'CONTEXT_COMPACTION_THRESHOLD_TOKENS',
      raw: undefined,
      defaultValue: DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS,
    });
    expect(value).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS);
    expect(value).toBe(50_000);
  });

  it('accepts a positive integer override', () => {
    const value = parsePositiveInt({
      envKey: 'CONTEXT_COMPACTION_THRESHOLD_TOKENS',
      raw: '80000',
      defaultValue: DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS,
    });
    expect(value).toBe(80_000);
  });

  it('rejects a non-positive value', () => {
    expect(() =>
      parsePositiveInt({
        envKey: 'CONTEXT_COMPACTION_THRESHOLD_TOKENS',
        raw: '0',
        defaultValue: DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS,
      }),
    ).toThrow('must be an integer of at least 1');
  });
});
