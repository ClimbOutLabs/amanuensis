'use client';

import type { serialization } from '@truefoundry/trueforge-sdk';
import { createContext, useContext, type FC, type ReactNode } from 'react';

/**
 * The bug-report wire contract, as it crosses the wire (snake_case). The generated SDK is the
 * one owner of these shapes; the UI only names them, so the bundle the reporter copies matches
 * the server's document byte for byte and cannot drift from it.
 */
export type BugReportTraceEvent = serialization.BugReportTraceEvent.Raw;
export type BugReportTurnTrace = serialization.BugReportTurnTrace.Raw;
export type BugReportError = serialization.BugReportError.Raw;
export type BugReportBundle = serialization.BugReportBundle.Raw;
export type BugReportChatMessage = serialization.BugReportChatMessage.Raw;
export type BugReportChat = serialization.BugReportChat.Raw;

export type BugReportApi = {
  /** Fetches the redacted bundle for one session from `POST /api/v1/sessions/{id}/bug-report`. */
  generateBugReport: (input: {
    sessionId: string;
    description: string;
    includeChat: boolean;
  }) => Promise<BugReportBundle>;
};

const BugReportContext = createContext<BugReportApi | null>(null);

export const BugReportProvider: FC<{ api: BugReportApi; children: ReactNode }> = ({ api, children }) => (
  <BugReportContext.Provider value={api}>{children}</BugReportContext.Provider>
);

/** Null when no host has wired a `BugReportProvider` — callers hide the "Report a bug" control in that case. */
export function useOptionalBugReport(): BugReportApi | null {
  return useContext(BugReportContext);
}

export function useBugReport(): BugReportApi {
  const context = useOptionalBugReport();
  if (context == null) {
    throw new Error('useBugReport must be used within a BugReportProvider.');
  }
  return context;
}
