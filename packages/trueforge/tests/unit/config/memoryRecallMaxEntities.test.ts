import { MEMORY_SETTINGS_LIMITS } from '@truefoundry/trueforge-core/core/memory/memorySettingsLimits';

import { parsePositiveInt } from '../../../src/config';

describe('MEMORY_RECALL_MAX_ENTITIES env parsing', () => {
  it('accepts zero, since the shared limit and per-bank schema both allow it to mean "no unscored entity summaries"', () => {
    const accepted = parsePositiveInt({
      envKey: 'MEMORY_RECALL_MAX_ENTITIES',
      raw: '0',
      defaultValue: 8,
      minValue: MEMORY_SETTINGS_LIMITS.recallMaxEntities.min,
      maxValue: MEMORY_SETTINGS_LIMITS.recallMaxEntities.max,
    });
    expect(accepted).toBe(0);
  });

  it('still rejects a negative value and one above the shared maximum', () => {
    const parse = (raw: string) =>
      parsePositiveInt({
        envKey: 'MEMORY_RECALL_MAX_ENTITIES',
        raw,
        defaultValue: 8,
        minValue: MEMORY_SETTINGS_LIMITS.recallMaxEntities.min,
        maxValue: MEMORY_SETTINGS_LIMITS.recallMaxEntities.max,
      });
    expect(() => parse('-1')).toThrow('must be an integer of at least 0');
    expect(() => parse(String(MEMORY_SETTINGS_LIMITS.recallMaxEntities.max + 1))).toThrow('must be at most');
  });

  it('defaults to requiring a positive value when minValue is not passed, unaffected by the new option', () => {
    expect(() => parsePositiveInt({ envKey: 'X', raw: '0', defaultValue: 1 })).toThrow(
      'must be an integer of at least 1',
    );
  });
});
