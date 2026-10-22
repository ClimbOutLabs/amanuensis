'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import type { HelpHealthCheck } from './helpModel.js';

export type HelpApi = {
  getHealthCheck: () => Promise<HelpHealthCheck>;
  /** Installs or refreshes Iris for this person. Resolves true when she is there to answer. */
  ensureGuide: () => Promise<boolean>;
};

/**
 * Where the help chat is. `pending` before the check starts; `no_model` and `check_failed` keep the
 * results and the next steps; `unavailable` means Iris could not join, so the chat says how to get help.
 */
export type HelpPhase = 'pending' | 'checking' | 'no_model' | 'check_failed' | 'joining' | 'joined' | 'unavailable';

export type HelpSession = {
  /** Changes on every start and every "Check again", so the runner knows to run. */
  runKey: number;
  /** Changes only on a start, so the new-chat bridge opens one fresh chat per press. */
  openNonce: number;
  screen: string;
  lastError: string | null;
  /** The local thread that was open when the help chat was requested. Null before the bridge reads it. */
  idBeforeOpen: string | null;
  /** The local thread the help chat lives in. Undefined until the fresh chat exists. */
  boundThreadId: string | undefined;
  phase: HelpPhase;
  check: HelpHealthCheck | null;
  /** The hidden message as sent, so the chat can show what Iris was told. */
  sentMessage: string | null;
};

export type HelpSessionUpdate = Partial<Pick<HelpSession, 'phase' | 'check' | 'sentMessage' | 'idBeforeOpen'>>;

export type HelpContextValue = {
  api: HelpApi | null;
  session: HelpSession | null;
  start: (input: { screen: string; lastError: string | null }) => void;
  update: (patch: HelpSessionUpdate) => void;
  bindThread: (threadId: string) => void;
  checkAgain: () => void;
  /** True when the help chat belongs to this thread. */
  isSessionFor: (threadId: string) => boolean;
};

const HelpContext = createContext<HelpContextValue | null>(null);

export function HelpProvider({ api, children }: { api: HelpApi; children: ReactNode }) {
  const [session, setSession] = useState<HelpSession | null>(null);

  const start = useCallback((input: { screen: string; lastError: string | null }) => {
    setSession(previous => ({
      runKey: (previous?.runKey ?? 0) + 1,
      openNonce: (previous?.openNonce ?? 0) + 1,
      screen: input.screen,
      lastError: input.lastError,
      idBeforeOpen: null,
      boundThreadId: undefined,
      phase: 'pending',
      check: null,
      sentMessage: null,
    }));
  }, []);

  const update = useCallback((patch: HelpSessionUpdate) => {
    setSession(previous => (previous === null ? previous : { ...previous, ...patch }));
  }, []);

  const bindThread = useCallback((threadId: string) => {
    setSession(previous =>
      previous === null || previous.boundThreadId !== undefined ? previous : { ...previous, boundThreadId: threadId },
    );
  }, []);

  const checkAgain = useCallback(() => {
    setSession(previous =>
      previous === null ? previous : { ...previous, runKey: previous.runKey + 1, phase: 'pending', check: null },
    );
  }, []);

  const isSessionFor = useCallback(
    (threadId: string) => session !== null && session.boundThreadId === threadId,
    [session],
  );

  const value = useMemo<HelpContextValue>(
    () => ({ api, session, start, update, bindThread, checkAgain, isSessionFor }),
    [api, session, start, update, bindThread, checkAgain, isSessionFor],
  );

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useOptionalHelp(): HelpContextValue | null {
  return useContext(HelpContext);
}
