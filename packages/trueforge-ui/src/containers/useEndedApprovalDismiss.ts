'use client';

import { useAuiState } from '@assistant-ui/react';
import { toolInvocationRawId, useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import { useCallback, useState } from 'react';

import { hasSessionResync } from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { useToasterOptional } from './ToasterContainer.js';

/**
 * Clears the card of a request that ended. The server records the dismissal and runs nothing; the
 * card is hidden at once and the chat reloads so it stays gone. `onDismiss` is undefined when this
 * card's thread is not known, so no Dismiss button is offered.
 */
export function useEndedApprovalDismiss({ toolCallId, threadId }: { toolCallId: string; threadId: string | null }): {
  onDismiss: (() => void) | undefined;
  dismissing: boolean;
  cleared: boolean;
} {
  const server = useOptionalServer();
  const sessionId = useAuiState(state => state.threadListItem?.remoteId);
  const reload = useTrueFoundryReload();
  const toaster = useToasterOptional();
  const [dismissing, setDismissing] = useState(false);
  const [cleared, setCleared] = useState(false);

  const onDismiss = useCallback(() => {
    if (server == null || !hasSessionResync(server) || sessionId == null || threadId == null || dismissing) return;
    setDismissing(true);
    server
      .dismissEndedApproval({ sessionId, threadId, toolCallId: toolInvocationRawId(toolCallId) })
      .then(() => {
        setCleared(true);
        reload();
      })
      .catch((error: unknown) => {
        toaster?.showError(error instanceof Error ? error : new Error('Could not clear this request.'));
      })
      .finally(() => {
        setDismissing(false);
      });
  }, [server, sessionId, threadId, toolCallId, dismissing, reload, toaster]);

  const canDismiss = server != null && hasSessionResync(server) && sessionId != null && threadId != null;
  return { onDismiss: canDismiss ? onDismiss : undefined, dismissing, cleared };
}
