'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

/**
 * The local sign-in account surface: changing the password Aman keeps itself.
 * Hosts provide it only for a local sign-in instance; absent it, the Account
 * section of Settings never renders.
 */
export type LocalAccountApi = {
  /**
   * Sets a new password after the current one checks out. Every other session
   * ends; this one stays signed in. A failure throws an Error whose message is
   * one plain line the form can show as-is.
   */
  changePassword: (input: { current_password: string; new_password: string }) => Promise<void>;
};

const LocalAccountContext = createContext<LocalAccountApi | null>(null);

export const LocalAccountProvider: FC<{ api: LocalAccountApi; children: ReactNode }> = ({ api, children }) => (
  <LocalAccountContext.Provider value={api}>{children}</LocalAccountContext.Provider>
);

export function useOptionalLocalAccount(): LocalAccountApi | null {
  return useContext(LocalAccountContext);
}
