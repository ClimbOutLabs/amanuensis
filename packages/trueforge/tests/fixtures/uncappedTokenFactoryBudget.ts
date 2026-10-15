import type { TokenFactoryBudget } from '../../src/runtime/tokenFactoryBudget';

/** A budget with no cap: admits every turn and counts nothing, like an instance without the env var. */
export const uncappedTokenFactoryBudget: TokenFactoryBudget = {
  assertWithinCap: () => Promise.resolve(),
  record: () => Promise.resolve(),
};
