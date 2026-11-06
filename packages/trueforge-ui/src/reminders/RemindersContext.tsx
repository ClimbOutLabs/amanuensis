'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

import type { RemindersApi } from './types.js';

type RemindersValue = {
  api: RemindersApi;
};

const RemindersContext = createContext<RemindersValue | null>(null);

export function useReminders(): RemindersValue {
  const value = useContext(RemindersContext);
  if (value === null) {
    throw new Error('Reminders are not available here. Open the app from its home screen, then try again.');
  }
  return value;
}

export function useOptionalReminders(): RemindersValue | null {
  return useContext(RemindersContext);
}

/** Hands the reminders API to the button and the view. The view fetches when it opens; nothing polls. */
export const RemindersProvider: FC<{ api: RemindersApi; children: ReactNode }> = ({ api, children }) => (
  <RemindersContext.Provider value={{ api }}>{children}</RemindersContext.Provider>
);
