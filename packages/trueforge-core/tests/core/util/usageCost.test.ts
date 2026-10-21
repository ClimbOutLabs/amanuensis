import { sumKnownCostUsd } from '../../../src/core/util/usageCost';

describe('sumKnownCostUsd', () => {
  it('adds every cost when all are known', () => {
    expect(sumKnownCostUsd([0.002, 0.004])).toBeCloseTo(0.006, 10);
  });

  it('is zero for no costs', () => {
    expect(sumKnownCostUsd([])).toBe(0);
  });

  it('is null when any cost is unknown, never a partial sum', () => {
    expect(sumKnownCostUsd([0.002, null, 0.004])).toBeNull();
    expect(sumKnownCostUsd([null])).toBeNull();
  });
});
