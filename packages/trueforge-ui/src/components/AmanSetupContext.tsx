'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

/**
 * A memory bank as the first screen reports it. `connected` is false while the connector still
 * waits on this user's sign-in: a flagged bank the user cannot reach recalls nothing, so it must
 * not read as on.
 */
export type MemoryBankStatus = { name: string; connected: boolean };

/**
 * The first-run checklist's put-away state, kept by the host on the server so it follows the
 * owner across browsers. `dismiss` is fire and forget; the host reports the new state back.
 */
export type FirstRunGuideState = { dismissed: boolean; dismiss: () => void };

/**
 * What the host has and has not set up yet, as the first screen needs to know it.
 *
 * Chat works with just a model, so nothing here blocks anything: the welcome screen lists what
 * is still unset and where to set it, and the runtime rail shows the memory bank in use.
 */
export type AmanSetupState = {
  /** The model the next chat will use; null when none is configured. */
  modelName: string | null;
  /**
   * The memory bank, null when memory is off, undefined when the host could not find out (the
   * screens then say nothing about memory rather than guessing).
   */
  memoryBank: MemoryBankStatus | null | undefined;
  /**
   * Whether this owner has started at least one chat; undefined when the host could not find
   * out, which leaves that line off the checklist.
   */
  hasChatted?: boolean | undefined;
  /** The checklist's dismissal; omitted shows the checklist without a way to put it away. */
  firstRunGuide?: FirstRunGuideState;
  /** Where the setup links point; omitted renders the same text without links. */
  settingsHref?: string;
};

const AmanSetupContext = createContext<AmanSetupState | null>(null);

export const AmanSetupProvider: FC<{ value: AmanSetupState; children: ReactNode }> = ({ value, children }) => (
  <AmanSetupContext.Provider value={value}>{children}</AmanSetupContext.Provider>
);

/** Null outside a provider, so hosts that do not report setup state render the plain screens. */
export function useOptionalAmanSetup(): AmanSetupState | null {
  return useContext(AmanSetupContext);
}
