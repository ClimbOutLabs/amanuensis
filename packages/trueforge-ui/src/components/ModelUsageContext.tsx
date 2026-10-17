'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

import type { ModelUsageEvent } from '../utils/modelUsage.js';

/** One turn's `aman.model.usage` events: the model calls it made, by role and model. */
export type ModelUsageTurnContext = {
  turnId: string;
  events: ModelUsageEvent[];
};

export type ModelUsageApi = {
  /** Every `aman.model.usage` event this session has recorded, by turn. */
  listModelUsage: (sessionId: string) => Promise<ModelUsageTurnContext[]>;
};

const ModelUsageContext = createContext<ModelUsageApi | null>(null);

/**
 * Opt-in, like `MemoryRecallProvider`: hosts that record model usage wrap their tree in this
 * provider. Absent it, `useOptionalModelUsage` returns `null` and no usage line is ever drawn.
 */
export const ModelUsageProvider: FC<{ api: ModelUsageApi; children: ReactNode }> = ({ api, children }) => (
  <ModelUsageContext.Provider value={api}>{children}</ModelUsageContext.Provider>
);

export function useOptionalModelUsage(): ModelUsageApi | null {
  return useContext(ModelUsageContext);
}
