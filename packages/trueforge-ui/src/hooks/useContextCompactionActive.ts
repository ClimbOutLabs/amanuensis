'use client';

import { useCallback, useSyncExternalStore } from 'react';

import { isContextCompacting, subscribeToContextCompaction } from '../utils/contextCompactionLive.js';

/** Whether this chat's history is being shortened right now, live from the turn stream. */
export function useContextCompactionActive(sessionId: string | undefined): boolean {
  const read = useCallback(() => sessionId !== undefined && isContextCompacting(sessionId), [sessionId]);
  return useSyncExternalStore(subscribeToContextCompaction, read, read);
}
