import { MEMORY_PROVIDER_MAX_TIMEOUT_MS } from '@truefoundry/trueforge-core/core/memory/memorySettingsLimits';

import { parsePositiveInt } from '../../../src/config';

describe('memory deadline env parsing', () => {
  it('accepts the shared maximum and rejects one above it, so the browser write deadline always covers a save', () => {
    const browserWriteDeadlineMs = 125_000;
    expect(MEMORY_PROVIDER_MAX_TIMEOUT_MS).toBeLessThan(browserWriteDeadlineMs);
    for (const envKey of ['MEMORY_RECALL_TIMEOUT_MS', 'MEMORY_CHECK_TIMEOUT_MS', 'MEMORY_REFLECT_TIMEOUT_MS']) {
      const accepted = parsePositiveInt({
        envKey,
        raw: String(MEMORY_PROVIDER_MAX_TIMEOUT_MS),
        defaultValue: 1,
        maxValue: MEMORY_PROVIDER_MAX_TIMEOUT_MS,
      });
      expect(accepted).toBe(MEMORY_PROVIDER_MAX_TIMEOUT_MS);
      expect(() =>
        parsePositiveInt({
          envKey,
          raw: String(MEMORY_PROVIDER_MAX_TIMEOUT_MS + 1),
          defaultValue: 1,
          maxValue: MEMORY_PROVIDER_MAX_TIMEOUT_MS,
        }),
      ).toThrow(`Environment variable ${envKey} must be at most ${String(MEMORY_PROVIDER_MAX_TIMEOUT_MS)}`);
    }
  });

  it('leaves an unset value at its default without consulting the cap', () => {
    expect(parsePositiveInt({ envKey: 'X', raw: undefined, defaultValue: 7, maxValue: 5 })).toBe(7);
  });
});
