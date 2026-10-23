'use client';

import { useAuiState } from '@assistant-ui/react';
import { parseTurnIdFromMessageId, useTrueFoundryCancelledTurn } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useRef } from 'react';

import { useOptionalPersonalization } from '../components/PersonalizationContext.js';
import { useChatNotice } from '../hooks/useChatNotice.js';
import { useComposerBusyState } from '../hooks/useComposerBusyState.js';
import { assistantDisplayName } from '../utils/assistantName.js';
import { cancelledTurnRefusal, sendRefusalText, type SendRefusal } from '../utils/turnRefusal.js';

/** Why the chat's last message got no reply, as saved with its turn, while that message is still the last one shown. */
function useSavedRefusal(): SendRefusal | undefined {
  const cancelledTurn = useTrueFoundryCancelledTurn();
  const lastMessageTurnId = useAuiState(state => {
    const last = state.thread.messages.at(-1);
    return last?.role === 'user' ? parseTurnIdFromMessageId(last.id) : undefined;
  });
  const isRunning = useAuiState(state => state.thread.isRunning);
  if (cancelledTurn == null || isRunning || lastMessageTurnId !== cancelledTurn.turnId) return undefined;
  return cancelledTurnRefusal(cancelledTurn.reason);
}

/** One plain line about the chat's last send, until the person sends again. */
export function ChatNoticeContainer() {
  const notice = useChatNotice();
  const savedRefusal = useSavedRefusal();
  const personalization = useOptionalPersonalization();
  const { isSubmitting } = useComposerBusyState();
  const wasSubmittingRef = useRef(isSubmitting);

  useEffect(() => {
    if (isSubmitting && !wasSubmittingRef.current) notice?.dismiss();
    wasSubmittingRef.current = isSubmitting;
  }, [isSubmitting, notice]);

  // The page's own notice and the reason saved with the turn are the same news; it is told once.
  const refusal = notice?.kind ?? (isSubmitting ? undefined : savedRefusal);
  if (refusal === undefined) return null;
  const assistantName = assistantDisplayName(personalization?.profile?.assistant_name);
  const line = (
    <p data-role="host-chat-notice" role="status" className="text-text-secondary mt-2 px-1 text-sm">
      {sendRefusalText({ refusal, assistantName })}
    </p>
  );
  // A reply that ended under the person's message takes the reply's place.
  const inReplyPlace = refusal === 'stopped_by_restart' || (notice == null && savedRefusal !== undefined);
  return inReplyPlace ? <div data-role="assistant">{line}</div> : line;
}
