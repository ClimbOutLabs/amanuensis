import type { TurnModelUsage } from '../../src/runtime/modelUsage';

/** Takes the calls a turn records and keeps none, for tests that are not about usage. */
export const discardedModelUsage: TurnModelUsage = {
  record: () => undefined,
};
