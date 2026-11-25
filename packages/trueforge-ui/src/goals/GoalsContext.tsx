'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

import type { GoalsApi } from './types.js';

type GoalsValue = {
  api: GoalsApi;
};

const GoalsContext = createContext<GoalsValue | null>(null);

export function useGoals(): GoalsValue {
  const value = useContext(GoalsContext);
  if (value === null) {
    throw new Error('Goals are not available here. Open the app from its home screen, then try again.');
  }
  return value;
}

export function useOptionalGoals(): GoalsValue | null {
  return useContext(GoalsContext);
}

/** Hands the goals API to the button, the views, and the chat entry point. Views fetch when they open; nothing polls. */
export const GoalsProvider: FC<{ api: GoalsApi; children: ReactNode }> = ({ api, children }) => (
  <GoalsContext.Provider value={{ api }}>{children}</GoalsContext.Provider>
);
