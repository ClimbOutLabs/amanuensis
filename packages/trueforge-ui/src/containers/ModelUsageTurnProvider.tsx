'use client';

import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';

import { useOptionalModelUsage, type ModelUsageTurnContext } from '../components/ModelUsageContext.js';
import { usePolledSessionContext } from '../hooks/usePolledSessionContext.js';
import { summarizeModelUsage, type ModelUsageSummary } from '../utils/modelUsage.js';

const EMPTY_MAP: ReadonlyMap<string, ModelUsageSummary> = new Map();

const ModelUsageSummariesContext = createContext<ReadonlyMap<string, ModelUsageSummary>>(EMPTY_MAP);

/**
 * Loads this session's model usage events (polled like the other host-recorded turn events, so a
 * turn's usage shows up without a reload) and exposes each turn's summary by turn id.
 *
 * Renders `children` unchanged when no host `ModelUsageProvider` is mounted.
 */
export function ModelUsageTurnProvider({ children }: PropsWithChildren) {
  const api = useOptionalModelUsage();
  const { data } = usePolledSessionContext<ModelUsageTurnContext[]>(api?.listModelUsage);
  const summaries = useMemo(() => {
    const byTurn = new Map<string, ModelUsageSummary>();
    for (const turn of data ?? []) {
      const summary = summarizeModelUsage(turn.events);
      if (summary !== undefined) byTurn.set(turn.turnId, summary);
    }
    return byTurn;
  }, [data]);

  return <ModelUsageSummariesContext.Provider value={summaries}>{children}</ModelUsageSummariesContext.Provider>;
}

/** What the turn spent, or undefined while unknown or when nothing was recorded for it. */
export function useModelUsageSummary(turnId: string | undefined): ModelUsageSummary | undefined {
  const summaries = useContext(ModelUsageSummariesContext);
  return turnId === undefined ? undefined : summaries.get(turnId);
}
