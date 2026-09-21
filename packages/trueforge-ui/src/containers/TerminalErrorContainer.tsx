'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryAgentSpec, useTrueFoundryTerminalError } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useRef, useState } from 'react';

import { useComposerBusyState } from '../hooks/useComposerBusyState.js';
import { useSlot } from '../theme/SlotsProvider.js';

/**
 * Shows the persisted turn failure outside assistant messages so empty failures
 * remain visible. Dismissed locally (not cleared from the runtime) as soon as
 * the user changes model/effort or starts a new send, so a stale banner from a
 * fixed mistake does not linger until the next turn completes.
 */
export function TerminalErrorContainer() {
  const MessageErrorBanner = useSlot('MessageErrorBanner');
  const terminalError = useTrueFoundryTerminalError();
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
  const [dismissedTurnId, setDismissedTurnId] = useState<string | null>(null);
  const prevModelKeyRef = useRef(modelKey);
  const wasBusyRef = useRef(isBusy);

  // Model or effort changed: the failed attempt no longer describes the pending choice.
  useEffect(() => {
    if (prevModelKeyRef.current !== modelKey) {
      prevModelKeyRef.current = modelKey;
      if (terminalError != null) setDismissedTurnId(terminalError.turnId);
    }
  }, [modelKey, terminalError]);

  // A new send started: stop showing the previous attempt's banner immediately.
  useEffect(() => {
    if (isBusy && !wasBusyRef.current && terminalError != null) {
      setDismissedTurnId(terminalError.turnId);
    }
    wasBusyRef.current = isBusy;
  }, [isBusy, terminalError]);

  if (terminalError == null || hasAssistantMessageForTurn || terminalError.turnId === dismissedTurnId) return null;

  return (
    <div data-role="host-terminal-error">
      <MessageErrorBanner message={terminalError.message} />
    </div>
  );
}
