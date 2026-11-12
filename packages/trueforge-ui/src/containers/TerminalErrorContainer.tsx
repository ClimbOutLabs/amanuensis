'use client';

import { useAuiState } from '@assistant-ui/react';
import {
  useTrueFoundryAgentSpec,
  useTrueFoundryReload,
  useTrueFoundryTerminalError,
} from '@truefoundry/assistant-ui-runtime';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useComposerBusyState } from '../hooks/useComposerBusyState.js';
import { useSlot } from '../theme/SlotsProvider.js';

/** Browser-local record of the failed turns whose banner the person has dismissed. */
const DISMISSED_TERMINAL_ERRORS_STORAGE_KEY = 'aui-dismissed-terminal-errors';
/** Old dismissals matter least; the record keeps only the most recent few. */
const DISMISSED_TERMINAL_ERRORS_LIMIT = 50;

function readDismissedTerminalErrorTurnIds(): ReadonlySet<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_TERMINAL_ERRORS_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    return new Set();
  }
}

function writeDismissedTerminalErrorTurnIds(turnIds: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return;
  try {
    const kept = [...turnIds].slice(-DISMISSED_TERMINAL_ERRORS_LIMIT);
    window.localStorage.setItem(DISMISSED_TERMINAL_ERRORS_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    /* Storage unavailable: the dismissal still holds for this page view. */
  }
}

/**
 * Shows the persisted turn failure outside assistant messages so empty failures
 * remain visible. The banner is dismissed (never cleared from the runtime, so
 * the turn still reads as failed in history) when the user dismisses it by
 * hand, changes model/effort, or starts a new send, so a stale banner from a
 * fixed mistake does not linger until the next turn completes. Dismissals are
 * kept in this browser, so neither a reload nor a retry brings the banner back.
 */
export function TerminalErrorContainer() {
  const MessageErrorBanner = useSlot('MessageErrorBanner');
  const terminalError = useTrueFoundryTerminalError();
  const reload = useTrueFoundryReload();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const { isBusy } = useComposerBusyState();
  const hasAssistantMessageForTurn = useAuiState(
    state =>
      terminalError != null &&
      state.thread.messages.some(
        message => message.role === 'assistant' && message.metadata.custom.turnId === terminalError.turnId,
      ),
  );

  const modelKey = `${agentSpec?.model?.name ?? ''}::${agentSpec?.model?.params?.reasoningEffort ?? ''}`;
  const [dismissedTurnIds, setDismissedTurnIds] = useState<ReadonlySet<string>>(readDismissedTerminalErrorTurnIds);
  const prevModelKeyRef = useRef(modelKey);
  const wasBusyRef = useRef(isBusy);

  const dismissTurn = useCallback((turnId: string) => {
    setDismissedTurnIds(previous => {
      if (previous.has(turnId)) return previous;
      const next = new Set(previous);
      next.add(turnId);
      writeDismissedTerminalErrorTurnIds(next);
      return next;
    });
  }, []);

  // Model or effort changed: the failed attempt no longer describes the pending choice.
  useEffect(() => {
    if (prevModelKeyRef.current !== modelKey) {
      prevModelKeyRef.current = modelKey;
      if (terminalError != null) dismissTurn(terminalError.turnId);
    }
  }, [modelKey, terminalError, dismissTurn]);

  // A new send started: stop showing the previous attempt's banner immediately.
  useEffect(() => {
    if (isBusy && !wasBusyRef.current && terminalError != null) {
      dismissTurn(terminalError.turnId);
    }
    wasBusyRef.current = isBusy;
  }, [isBusy, terminalError, dismissTurn]);

  if (terminalError == null || hasAssistantMessageForTurn || dismissedTurnIds.has(terminalError.turnId)) return null;

  return (
    <div data-role="host-terminal-error">
      <MessageErrorBanner
        message={terminalError.message}
        action={{ label: 'Retry', onClick: () => reload() }}
        onDismiss={() => dismissTurn(terminalError.turnId)}
      />
    </div>
  );
}
