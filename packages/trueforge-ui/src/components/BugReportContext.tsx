'use client';

import type { serialization } from '@truefoundry/trueforge-sdk';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
  type RefObject,
} from 'react';

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

/**
 * App-level bug-report bundle: the wire contract (snake_case) for `POST /api/v1/bug-reports`.
 * Session-less by design — build identity, the reporter's description, non-secret config
 * flags, and the redaction notes. No session id, no trace, no chat: there is nothing
 * session-bound here to redact. The single canonical owner is `AppBugReportBundleSchema` in
 * `packages/trueforge/src/schemas/bugReport.ts` (the exact same fields off the session
 * bundle); this names those fields off the generated SDK's projection of that canonical
 * shape until the SDK regenerates with the new endpoint — then prefer
 * `serialization.AppBugReportBundle.Raw`.
 */
export type AppBugReportBundle = Pick<
  BugReportBundle,
  'schema_version' | 'generated_at' | 'build' | 'user_description' | 'config_flags' | 'redaction'
>;

/** The configured issue-tracker handoff, or null when the host disabled it. */
export type BugReportHandoffTarget = { issueUrl: string } | null;

export type BugReportApi = {
  /** Fetches the redacted bundle for one session from `POST /api/v1/sessions/{id}/bug-report`. */
  generateBugReport: (input: {
    sessionId: string;
    description: string;
    includeChat: boolean;
  }) => Promise<BugReportBundle>;
  /**
   * Fetches the redacted app-level bundle from `POST /api/v1/bug-reports`. Needs no session,
   * so bug reporting works outside a chat too.
   */
  generateAppBugReport: (input: { description: string }) => Promise<AppBugReportBundle>;
  /** The issue-tracker URL bug reports hand off to, from `GET /api/v1/bug-reports/handoff`. */
  getBugReportHandoff: () => Promise<BugReportHandoffTarget>;
};

/** Open state of the one bug report dialog, which the app shell mounts. Buttons only ask for it open. */
export type BugReportDialogControl = {
  open: boolean;
  /** Asking to open is ignored while no dialog is mounted, so a stale request cannot pop up later. */
  setOpen: (open: boolean) => void;
  /** A mounted dialog registers here; the returned function unregisters it and closes the form. */
  registerDialog: () => () => void;
  /** Where focus goes on close, for openers that unmount as they open (menu rows). */
  returnFocusRef: RefObject<HTMLElement | null>;
};

const BugReportContext = createContext<BugReportApi | null>(null);
const BugReportDialogContext = createContext<BugReportDialogControl | null>(null);

/** The open flag lives above the layouts so a menu row can open the dialog and then unmount safely. */
export const BugReportProvider: FC<{ api: BugReportApi; children: ReactNode }> = ({ api, children }) => {
  const [open, setOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const mountedDialogs = useRef(0);
  const requestOpen = useCallback((next: boolean) => {
    if (next && mountedDialogs.current === 0) return;
    setOpen(next);
  }, []);
  const registerDialog = useCallback(() => {
    mountedDialogs.current += 1;
    returnFocusRef.current = null;
    return () => {
      mountedDialogs.current -= 1;
      if (mountedDialogs.current === 0) setOpen(false);
    };
  }, []);
  const dialog = useMemo<BugReportDialogControl>(
    () => ({ open, setOpen: requestOpen, registerDialog, returnFocusRef }),
    [open, requestOpen, registerDialog],
  );
  return (
    <BugReportContext.Provider value={api}>
      <BugReportDialogContext.Provider value={dialog}>{children}</BugReportDialogContext.Provider>
    </BugReportContext.Provider>
  );
};

/** Null when no host has wired a `BugReportProvider`. */
export function useOptionalBugReportDialog(): BugReportDialogControl | null {
  return useContext(BugReportDialogContext);
}

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
