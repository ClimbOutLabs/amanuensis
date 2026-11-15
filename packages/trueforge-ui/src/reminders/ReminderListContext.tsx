'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

import type { RemindersApi } from './types.js';

type ReminderListValue = {
  api: RemindersApi;
};

const ReminderListContext = createContext<ReminderListValue | null>(null);

export function useReminderList(): ReminderListValue {
  const value = useContext(ReminderListContext);
  if (value === null) {
    throw new Error('Reminders are not available here. Open the app from its home screen, then try again.');
  }
  return value;
}

export function useOptionalReminderList(): ReminderListValue | null {
  return useContext(ReminderListContext);
}

/** Hands the reminders API to the button and the view. The view fetches when it opens; nothing polls. */
export const ReminderListProvider: FC<{ api: RemindersApi; children: ReactNode }> = ({ api, children }) => (
  <ReminderListContext.Provider value={{ api }}>{children}</ReminderListContext.Provider>
);
