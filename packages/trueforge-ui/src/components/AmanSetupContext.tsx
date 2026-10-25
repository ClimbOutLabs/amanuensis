'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

/**
 * The first-run checklist's put-away state, kept by the host on the server so it follows the
 * owner across browsers. `dismiss` is fire and forget; the host reports the new state back.
 */
export type FirstRunGuideState = { dismissed: boolean; dismiss: () => void };

/**
 * What the host has and has not set up yet, as the first screen needs to know it.
 *
 * Chat works with just a model, so nothing here blocks anything: the welcome screen lists what
 * is still unset and where to set it.
 */
export type AmanSetupState = {
  /** The model the next chat will use; null when none is configured. */
  modelName: string | null;
  /**
   * Whether this owner has started at least one chat; undefined when the host could not find
   * out, which leaves that line off the checklist.
   */
  hasChatted?: boolean | undefined;
  /** Whether the owner has a morning brief yet; the Productivity pill is gold once it does. */
  hasBrief?: boolean;
  /** The setup ticket's dismissal (Skip); omitted shows the ticket without a way to put it away. */
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
