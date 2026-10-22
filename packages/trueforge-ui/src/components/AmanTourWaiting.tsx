'use client';

import { createContext, useContext, useMemo, type FC, type ReactNode } from 'react';

import { useAnswerableApprovals } from '../hooks/useAnswerableApprovals.js';

/** What is waiting on the person in the runtime the tour sits in. */
type TourWaiting = {
  count: number;
  /** The first of them, the card the first frame may highlight. */
  firstId: string | null;
};

const NOTHING_WAITING: TourWaiting = { count: 0, firstId: null };

const TourWaitingContext = createContext<TourWaiting>(NOTHING_WAITING);

export function useTourWaiting(): TourWaiting {
  return useContext(TourWaitingContext);
}

/**
 * Reads the answerable approvals from the thread runtime and offers them to the welcome screen.
 * The welcome screen itself does not touch the runtime, so it renders outside a thread too.
 */
export const RuntimeTourWaiting: FC<{ children: ReactNode }> = ({ children }) => {
  const { pending } = useAnswerableApprovals();
  const value = useMemo<TourWaiting>(
    () => ({ count: pending.length, firstId: pending[0]?.approvalId ?? null }),
    [pending],
  );
  return <TourWaitingContext.Provider value={value}>{children}</TourWaitingContext.Provider>;
};
