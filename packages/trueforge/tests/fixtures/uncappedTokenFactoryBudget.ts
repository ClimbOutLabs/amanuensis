import type { TokenFactoryBudget } from '../../src/runtime/tokenFactoryBudget';

/** A budget with no cap: admits every turn and counts nothing, like an instance without the env var. */
export const uncappedTokenFactoryBudget: TokenFactoryBudget = {
  isExhausted: () => Promise.resolve(false),
  assertWithinCap: () => Promise.resolve(),
  record: () => Promise.resolve(),
};
