/**
 * Adds costs into one total, or null when any cost is unknown. A partial sum is never shown as the
 * total, so one unpriced call makes the whole figure unknown.
 */
export function sumKnownCostUsd(costs: readonly (number | null)[]): number | null {
  let total = 0;
  for (const cost of costs) {
    if (cost === null) {
      return null;
    }
    total += cost;
  }
  return total;
}
